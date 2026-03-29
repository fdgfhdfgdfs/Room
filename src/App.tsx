import React, { useState, useEffect } from 'react';
import { auth, db, signInWithGoogle, logout } from './firebase';
import { onAuthStateChanged, User, GoogleAuthProvider, signInWithRedirect } from 'firebase/auth';
import { doc, setDoc, getDoc, updateDoc, onSnapshot, deleteDoc, collection, getDocs, addDoc } from 'firebase/firestore';
import { LogOut, Copy, LogIn, Play, Check, X, Clock, Trophy, ArrowRight, Users, Dices, MessageCircleQuestion, Pencil } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type RoomStatus = 'waiting' | 'asking' | 'answering' | 'judging' | 'finished' | 'decisive_setup';
type GameMode = 'custom' | 'auto';

interface PlayerData {
  name: string;
  score: number;
  usedBets: number[];
}

interface AnswerData {
  answerText: string;
  betAmount: number;
}

interface QuestionData {
  id: string;
  question: string;
  options: string[];
  correctAnswer: string;
  category?: string;
  difficulty?: string;
}

interface RoomData {
  hostId: string;
  status: RoomStatus;
  gameMode: GameMode;
  playerOrder: string[];
  players: Record<string, PlayerData>;
  currentAskerIndex: number;
  currentQuestion: string;
  currentQuestionData: QuestionData | null;
  askedQuestions: string[];
  answers: Record<string, AnswerData>;
  questionStartedAt: number | null;
  roundTime: number;
  isDecisive?: boolean;
}

const ROUND_TIME = 16;

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [customName, setCustomName] = useState('');
  const [isNameSet, setIsNameSet] = useState(false);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomData, setRoomData] = useState<RoomData | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);

  const [timeLeft, setTimeLeft] = useState(ROUND_TIME);
  const [questionInput, setQuestionInput] = useState('');
  const [answerInput, setAnswerInput] = useState('');
  const [selectedBet, setSelectedBet] = useState<number | null>(null);
  const [judgments, setJudgments] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const savedName = localStorage.getItem(`customName_${currentUser.uid}`);
        if (savedName) {
          setCustomName(savedName);
          setIsNameSet(true);
        } else {
          setCustomName(currentUser.displayName || '');
          setIsNameSet(false);
        }
      }
      setLoadingAuth(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!roomId || !user) return;
    const roomRef = doc(db, 'rooms', roomId);
    const unsubscribe = onSnapshot(roomRef, (snapshot) => {
      if (snapshot.exists()) {
        setRoomData(snapshot.data() as RoomData);
      } else {
        setRoomData(null);
        setRoomId(null);
        setError('الغرفة غير موجودة أو تم إغلاقها.');
      }
    }, (err) => {
      console.error("Error listening to room:", err);
      setError('خطأ في الاتصال.');
    });
    return () => unsubscribe();
  }, [roomId, user]);

  useEffect(() => {
    if (roomData?.status === 'answering' && roomData.questionStartedAt) {
      const currentRoundTime = roomData.roundTime || 15;
      const interval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - roomData.questionStartedAt!) / 1000);
        const remaining = Math.max(0, currentRoundTime - elapsed);
        setTimeLeft(remaining);

        if (remaining === 0) {
          clearInterval(interval);
          
          // Auto-submit logic for all players
          if (user && !roomData.answers[user.uid] && roomData.playerOrder.includes(user.uid)) {
            const isAsker = !roomData.isDecisive && roomData.gameMode === 'custom' && user.uid === roomData.playerOrder[roomData.currentAskerIndex];
            if (!isAsker) {
               const finalAnswer = answerInput.trim() || 'لم يجب';
               let finalBet = roomData.isDecisive ? 20 : (selectedBet || 0);
               
               if (!roomData.isDecisive && !selectedBet) {
                 const usedBets = roomData.players[user.uid]?.usedBets || [];
                 for (let i = 1; i <= 20; i++) {
                   if (!usedBets.includes(i)) {
                     finalBet = i;
                     break;
                   }
                 }
               }

               updateDoc(doc(db, 'rooms', roomId!), {
                 [`answers.${user.uid}`]: {
                   answerText: finalAnswer,
                   betAmount: finalBet
                 }
               }).catch(console.error);
            }
          }

          // Auto Mode or Decisive Question: Host auto-judges after a 2-second delay to allow auto-submits
          if ((roomData.gameMode === 'auto' || roomData.isDecisive) && user?.uid === roomData.hostId) {
            setTimeout(async () => {
              try {
                const roomSnap = await getDoc(doc(db, 'rooms', roomId!));
                if (!roomSnap.exists()) return;
                const latestRoomData = roomSnap.data() as RoomData;
                
                if (latestRoomData.status !== 'answering') return; // Prevent double scoring
                
                const newPlayers = { ...latestRoomData.players };
                Object.entries(latestRoomData.answers as Record<string, AnswerData>).forEach(([uid, ans]) => {
                  const isCorrect = ans.answerText === latestRoomData.currentQuestionData?.correctAnswer;
                  if (!latestRoomData.isDecisive) {
                    newPlayers[uid].usedBets = [...(newPlayers[uid].usedBets || []), ans.betAmount];
                  }
                  if (isCorrect) {
                    newPlayers[uid].score += ans.betAmount;
                  }
                });
                
                let newAskedQuestions = latestRoomData.askedQuestions || [];
                if (!latestRoomData.isDecisive) {
                  newAskedQuestions = [...newAskedQuestions, latestRoomData.currentQuestionData!.id];
                }

                await updateDoc(doc(db, 'rooms', roomId!), {
                  status: 'judging',
                  players: newPlayers,
                  askedQuestions: newAskedQuestions
                });
              } catch (err) {
                console.error("Error auto-judging:", err);
              }
            }, 2000);
          } 
          // Custom Mode: Current asker transitions to judging after 2 seconds
          else if (!roomData.isDecisive && roomData.gameMode === 'custom' && user?.uid === roomData.playerOrder[roomData.currentAskerIndex]) {
            setTimeout(() => {
              updateDoc(doc(db, 'rooms', roomId!), { status: 'judging' }).catch(console.error);
            }, 2000);
          }
        }
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setTimeLeft(roomData?.roundTime || 15);
    }
  }, [roomData?.status, roomData?.questionStartedAt, roomId, user, roomData?.currentAskerIndex, roomData?.playerOrder, roomData?.gameMode, roomData?.answers, roomData?.currentQuestionData, roomData?.players, roomData?.askedQuestions, roomData?.hostId, roomData?.roundTime, roomData?.isDecisive, answerInput, selectedBet]);

  // Auto-next question effect for Auto Mode and Decisive Question
  useEffect(() => {
    if (roomData?.status === 'judging' && (roomData.gameMode === 'auto' || roomData.isDecisive) && user?.uid === roomData.hostId) {
      const timer = setTimeout(() => {
        if (roomData.isDecisive) {
          updateDoc(doc(db, 'rooms', roomId!), { status: 'finished' }).catch(console.error);
        } else if ((roomData.askedQuestions?.length || 0) >= 20) {
          updateDoc(doc(db, 'rooms', roomId!), { status: 'decisive_setup' }).catch(console.error);
        } else {
          fetchNextQuestion();
        }
      }, 5000); // Wait 5 seconds to show the answer, then fetch next
      return () => clearTimeout(timer);
    }
  }, [roomData?.status, roomData?.gameMode, user?.uid, roomData?.hostId, roomData?.isDecisive, roomData?.askedQuestions, roomId]);

  const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

  const createRoom = async (mode: GameMode) => {
    if (!user || !isNameSet) return;
    setError('');
    const newRoomId = generateRoomCode();
    const roomRef = doc(db, 'rooms', newRoomId);
    
    const initialData: RoomData = {
      hostId: user.uid,
      status: 'waiting',
      gameMode: mode,
      playerOrder: [user.uid],
      players: {
        [user.uid]: { name: customName, score: 0, usedBets: [] }
      },
      currentAskerIndex: 0,
      currentQuestion: '',
      currentQuestionData: null,
      askedQuestions: [],
      answers: {},
      questionStartedAt: null,
      roundTime: 15
    };

    try {
      await setDoc(roomRef, initialData);
      setRoomId(newRoomId);
    } catch (err) {
      setError('فشل إنشاء الغرفة.');
    }
  };

  const joinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !joinCode.trim() || !isNameSet) return;
    setError('');
    const code = joinCode.trim().toUpperCase();
    const roomRef = doc(db, 'rooms', code);
    
    try {
      const roomSnap = await getDoc(roomRef);
      if (!roomSnap.exists()) {
        setError('الغرفة غير موجودة.');
        return;
      }
      const data = roomSnap.data() as RoomData;
      
      if (data.status === 'waiting' && !data.playerOrder.includes(user.uid)) {
        await updateDoc(roomRef, {
          playerOrder: [...data.playerOrder, user.uid],
          [`players.${user.uid}`]: { name: customName, score: 0, usedBets: [] }
        });
      }
      setRoomId(code);
    } catch (err) {
      setError('فشل الانضمام للغرفة.');
    }
  };

  const leaveRoom = async () => {
    if (!roomId || !user || !roomData) return;
    if (roomData.hostId === user.uid) {
      try { await deleteDoc(doc(db, 'rooms', roomId)); } catch (err) {}
    }
    setRoomId(null);
    setRoomData(null);
  };

  const startGame = async () => {
    if (!roomId) return;
    if (roomData?.gameMode === 'auto') {
      fetchNextQuestion();
    } else {
      await updateDoc(doc(db, 'rooms', roomId), { status: 'asking' });
    }
  };

  // For Auto Mode
  const fetchNextQuestion = async () => {
    if (!roomId || !roomData) return;
    try {
      console.log("Fetching questions from Firestore...");
      const qSnap = await getDocs(collection(db, 'questions'));
      console.log("Fetched documents count:", qSnap.size);
      
      if (qSnap.empty) {
        console.error("No questions found in the 'questions' collection.");
        alert("قاعدة البيانات الخاصة بك فارغة حالياً! يرجى الذهاب إلى لوحة تحكم Firebase وإضافة أسئلة في مجموعة (collection) باسم 'questions'.");
        return;
      }

      const allQuestions = qSnap.docs.map(d => ({ id: d.id, ...d.data() } as QuestionData));
      const asked = roomData.askedQuestions || [];
      const available = allQuestions.filter(q => !asked.includes(q.id));

      if (available.length === 0) {
        alert("لقد انتهت جميع الأسئلة في قاعدة البيانات!");
        return;
      }

      const randomQ = available[Math.floor(Math.random() * available.length)];
      console.log("Selected question:", randomQ);

      await updateDoc(doc(db, 'rooms', roomId), {
        currentQuestionData: randomQ,
        currentQuestion: randomQ.question || "سؤال بدون نص",
        status: 'answering',
        questionStartedAt: Date.now(),
        answers: {}
      });
      
      setAnswerInput('');
      setSelectedBet(null);
    } catch (err) {
      console.error("Error fetching questions:", err);
      alert(`حدث خطأ أثناء جلب السؤال: ${err instanceof Error ? err.message : 'خطأ غير معروف'}`);
    }
  };

  const fetchDecisiveQuestion = async (difficulty: 'متوسط' | 'صعب') => {
    if (!roomId || !roomData) return;
    try {
      const qSnap = await getDocs(collection(db, 'questions'));
      
      if (qSnap.empty) {
        alert("قاعدة البيانات الخاصة بك فارغة حالياً!");
        return;
      }

      const allQuestions = qSnap.docs.map(d => ({ id: d.id, ...d.data() } as QuestionData));
      const asked = roomData.askedQuestions || [];
      
      // Try to find a question matching the difficulty, otherwise fallback to any available
      let available = allQuestions.filter(q => !asked.includes(q.id) && q.difficulty === difficulty);
      if (available.length === 0) {
        available = allQuestions.filter(q => !asked.includes(q.id));
      }

      if (available.length === 0) {
        alert("لقد انتهت جميع الأسئلة في قاعدة البيانات!");
        return;
      }

      const randomQ = available[Math.floor(Math.random() * available.length)];

      await updateDoc(doc(db, 'rooms', roomId), {
        currentQuestionData: randomQ,
        currentQuestion: randomQ.question || "سؤال بدون نص",
        status: 'answering',
        questionStartedAt: Date.now(),
        answers: {},
        isDecisive: true
      });
      
      setAnswerInput('');
      setSelectedBet(null);
    } catch (err) {
      console.error("Error fetching decisive question:", err);
      alert(`حدث خطأ أثناء جلب السؤال الحاسم: ${err instanceof Error ? err.message : 'خطأ غير معروف'}`);
    }
  };

  // For Custom Mode
  const submitQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomId || !questionInput.trim() || !roomData) return;
    
    const newAskedQuestions = [...(roomData.askedQuestions || []), `custom_${Date.now()}`];
    
    await updateDoc(doc(db, 'rooms', roomId), {
      currentQuestion: questionInput.trim(),
      status: 'answering',
      questionStartedAt: Date.now(),
      answers: {},
      askedQuestions: newAskedQuestions
    });
    setQuestionInput('');
    setAnswerInput('');
    setSelectedBet(null);
  };

  const submitAnswer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomId || !user || !answerInput.trim()) return;
    
    let finalBet = selectedBet;
    if (roomData?.isDecisive) {
      finalBet = 20;
    } else {
      const usedBets = roomData?.players[user.uid]?.usedBets || [];
      if (!finalBet) {
        for (let i = 1; i <= 20; i++) {
          if (!usedBets.includes(i)) {
            finalBet = i;
            break;
          }
        }
      }
      if (!finalBet) return;
      if (usedBets.includes(finalBet)) {
        alert("لقد استخدمت رقم الرهان هذا من قبل!");
        return;
      }
    }

    await updateDoc(doc(db, 'rooms', roomId), {
      [`answers.${user.uid}`]: {
        answerText: answerInput.trim(),
        betAmount: finalBet
      }
    });
  };

  // For Custom Mode
  const endTurn = async () => {
    if (!roomId || !roomData) return;
    
    const newPlayers = { ...roomData.players };
    Object.entries(roomData.answers as Record<string, AnswerData>).forEach(([uid, ans]) => {
      const isCorrect = judgments[uid];
      if (!roomData.isDecisive) {
        newPlayers[uid].usedBets = [...(newPlayers[uid].usedBets || []), ans.betAmount];
      }
      if (isCorrect) {
        newPlayers[uid].score += ans.betAmount;
      }
    });

    let nextStatus: RoomStatus = 'asking';
    if (roomData.isDecisive) {
      nextStatus = 'finished';
    } else if ((roomData.askedQuestions?.length || 0) >= 20) {
      nextStatus = 'decisive_setup';
    }

    await updateDoc(doc(db, 'rooms', roomId), {
      players: newPlayers,
      status: nextStatus,
      currentAskerIndex: (roomData.currentAskerIndex + 1) % roomData.playerOrder.length,
      currentQuestion: '',
      answers: {},
      questionStartedAt: null
    });
    setJudgments({});
    setAnswerInput('');
    setSelectedBet(null);
  };

  // For Auto Mode
  const nextAutoRound = async () => {
    if (!roomId) return;
    await updateDoc(doc(db, 'rooms', roomId), {
      status: 'asking',
      currentQuestion: '',
      currentQuestionData: null,
      answers: {},
      questionStartedAt: null
    });
    setAnswerInput('');
    setSelectedBet(null);
  };

  // الجزء الذي تم تعديله لحل مشكلة الشاشة البيضاء
  const handleSignIn = async () => {
    if (isSigningIn) return;
    setIsSigningIn(true);
    try {
      const provider = new GoogleAuthProvider();
      await signInWithRedirect(auth, provider);
    } catch (err) {
      console.error(err);
      setIsSigningIn(false);
    }
  };

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName.trim() || !user) return;
    localStorage.setItem(`customName_${user.uid}`, customName.trim());
    setIsNameSet(true);
  };

  const handleUpdateName = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customName.trim() || !user) return;
    localStorage.setItem(`customName_${user.uid}`, customName.trim());
    setIsEditingName(false);
  };

  if (loadingAuth) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white" dir="rtl">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-[100dvh] overflow-hidden bg-slate-900 flex flex-col items-center justify-center text-white p-4" dir="rtl">
        <div className="max-w-md w-full bg-slate-800 p-6 sm:p-8 rounded-3xl shadow-2xl border border-slate-700 text-center flex flex-col max-h-[90dvh]">
          <div className="bg-slate-900 w-20 h-20 sm:w-24 sm:h-24 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6 border-4 border-slate-800 shadow-inner shrink-0">
            <Trophy className="w-10 h-10 sm:w-12 sm:h-12 text-yellow-400" />
          </div>
          <h1 className="text-3xl sm:text-4xl font-black mb-2 tracking-tight shrink-0">تحدي كرة القدم</h1>
          <p className="text-slate-400 mb-8 sm:mb-10 text-base sm:text-lg shrink-0">لعبة أسئلة ورهانات متعددة اللاعبين</p>
          <button
            onClick={handleSignIn}
            disabled={isSigningIn}
            className="w-full flex items-center justify-center gap-3 bg-white text-slate-900 py-3 sm:py-4 px-4 rounded-2xl font-bold text-base sm:text-lg hover:bg-slate-100 transition-all active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed shadow-xl shadow-white/10 shrink-0"
          >
            {isSigningIn ? (
              <div className="animate-spin rounded-full h-5 w-5 sm:h-6 sm:w-6 border-t-2 border-b-2 border-slate-900"></div>
            ) : (
              <LogIn className="w-5 h-5 sm:w-6 sm:h-6" />
            )}
            {isSigningIn ? 'جاري تسجيل الدخول...' : 'تسجيل الدخول باستخدام جوجل'}
          </button>
        </div>
      </div>
    );
  }

  if (!isNameSet) {
    return (
      <div className="h-[100dvh] overflow-hidden bg-slate-900 flex flex-col items-center justify-center text-white p-4" dir="rtl">
        <div className="max-w-md w-full bg-slate-800 p-6 sm:p-8 rounded-3xl shadow-2xl border border-slate-700 text-center flex flex-col max-h-[90dvh]">
          <h2 className="text-xl sm:text-2xl font-bold mb-6 shrink-0">اختر اسمك في اللعبة</h2>
          <form onSubmit={handleSaveName} className="space-y-4 sm:space-y-6 shrink-0">
            <input
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="اكتب اسمك هنا..."
              className="w-full bg-slate-900 border border-slate-600 rounded-2xl p-3 sm:p-4 text-white focus:outline-none focus:border-blue-500 text-center text-lg sm:text-xl font-bold"
              required
              maxLength={15}
            />
            <button
              type="submit"
              disabled={!customName.trim()}
              className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 py-3 sm:py-4 rounded-2xl font-bold text-base sm:text-lg transition-all active:scale-95"
            >
              حفظ ومتابعة
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!roomId || !roomData) {
    return (
      <div className="h-[100dvh] overflow-hidden bg-slate-900 text-white p-4 flex flex-col items-center justify-center" dir="rtl">
        <div className="absolute top-4 left-4 flex items-center gap-3 sm:gap-4 z-10">
          <button onClick={logout} className="p-2 sm:p-3 bg-slate-800 rounded-full hover:bg-slate-700 transition-colors shadow-lg" title="تسجيل الخروج">
            <LogOut className="w-4 h-4 sm:w-5 sm:h-5 text-red-400" />
          </button>
          {isEditingName ? (
            <form onSubmit={handleUpdateName} className="flex items-center gap-2 bg-slate-800 p-1 rounded-full border border-slate-600">
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                className="bg-slate-900 border-none rounded-full px-3 py-1 text-xs sm:text-sm text-white focus:outline-none w-24 sm:w-32 text-center font-bold"
                maxLength={15}
                autoFocus
              />
              <button type="submit" disabled={!customName.trim()} className="p-1.5 bg-green-600 rounded-full hover:bg-green-500 text-white disabled:opacity-50 transition-colors">
                <Check className="w-3 h-3 sm:w-4 sm:h-4" />
              </button>
            </form>
          ) : (
            <div className="flex items-center gap-2 bg-slate-800 px-3 py-1.5 sm:px-4 sm:py-2 rounded-full border border-slate-700 shadow-lg">
              <span className="text-xs sm:text-sm font-bold text-slate-300">{customName}</span>
              <button onClick={() => setIsEditingName(true)} className="text-slate-400 hover:text-white transition-colors p-1" title="تعديل الاسم">
                <Pencil className="w-3 h-3 sm:w-4 sm:h-4" />
              </button>
            </div>
          )}
        </div>

        <div className="max-w-md w-full bg-slate-800 p-4 sm:p-6 rounded-3xl shadow-2xl border border-slate-700 text-center flex flex-col max-h-[90dvh]">
          <div className="bg-slate-900 w-16 h-16 sm:w-20 sm:h-20 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6 border-4 border-slate-800 shadow-inner shrink-0">
            <Trophy className="w-8 h-8 sm:w-10 sm:h-10 text-yellow-400" />
          </div>
          <h2 className="text-2xl sm:text-3xl font-black mb-4 sm:mb-6 tracking-tight shrink-0">صالة اللعب</h2>

          {error && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-3 rounded-xl mb-4 text-xs font-medium shrink-0">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-3 mb-4 shrink-0">
            <button
              onClick={() => createRoom('custom')}
              className="bg-slate-700 hover:bg-slate-600 text-white py-3 px-4 rounded-2xl font-bold transition-all active:scale-95 flex items-center justify-between border border-slate-600"
            >
              <div className="flex flex-col items-start">
                <span className="text-base">اسأل صديقك</span>
                <span className="text-[10px] text-slate-400 font-normal">تكتب السؤال بنفسك</span>
              </div>
              <MessageCircleQuestion className="w-6 h-6 text-blue-400" />
            </button>
            <button
              onClick={() => createRoom('auto')}
              className="bg-purple-600 hover:bg-purple-700 text-white py-3 px-4 rounded-2xl font-bold transition-all active:scale-95 flex items-center justify-between shadow-lg shadow-purple-500/20"
            >
              <div className="flex flex-col items-start">
                <span className="text-base">تحدي أصدقائك</span>
                <span className="text-[10px] text-purple-200 font-normal">أسئلة عشوائية من النظام</span>
              </div>
              <Dices className="w-6 h-6 text-white" />
            </button>
          </div>

          <div className="relative flex py-2 items-center mb-4 shrink-0">
            <div className="flex-grow border-t border-slate-700"></div>
            <span className="flex-shrink-0 mx-4 text-slate-500 text-xs font-bold">أو انضم لغرفة</span>
            <div className="flex-grow border-t border-slate-700"></div>
          </div>

          <form onSubmit={joinRoom} className="flex flex-col gap-3 shrink-0">
            <input
              type="text"
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="كود الغرفة"
              className="w-full bg-slate-900 border border-slate-600 rounded-2xl px-3 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 uppercase tracking-widest text-center font-mono text-lg font-bold"
              maxLength={6}
              dir="ltr"
            />
            <button
              type="submit"
              disabled={!joinCode.trim()}
              className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 text-white px-4 py-3 rounded-2xl font-bold transition-all active:scale-95 shadow-lg shadow-blue-500/20"
            >
              انضمام
            </button>
          </form>
        </div>
      </div>
    );
  }

  const isHost = user.uid === roomData.hostId;
  const currentAskerId = roomData.playerOrder[roomData.currentAskerIndex];
  const isAsker = roomData.isDecisive ? false : (roomData.gameMode === 'custom' ? user.uid === currentAskerId : isHost);
  const askerName = roomData.isDecisive ? 'النظام' : (roomData.gameMode === 'custom' ? (roomData.players[currentAskerId]?.name || 'شخص ما') : 'النظام');

  // Find winner if game finished
  let winner: PlayerData | null = null;
  if (roomData.status === 'finished') {
    let maxScore = -1;
    Object.values(roomData.players as Record<string, PlayerData>).forEach(p => {
      if (p.score > maxScore) {
        maxScore = p.score;
        winner = p;
      }
    });
  }

  const playerListPanel = (
    <div className="flex-1 min-h-[60px] bg-slate-900/50 rounded-xl border border-slate-700/50 p-2 flex flex-col">
      <h4 className="text-[10px] sm:text-xs font-bold text-slate-400 mb-1.5 text-center shrink-0">ترتيب اللاعبين</h4>
      <div className="flex-1 overflow-y-auto pr-1 space-y-1 custom-scrollbar">
        {(Object.entries(roomData.players) as [string, PlayerData][])
          .sort(([, a], [, b]) => b.score - a.score)
          .map(([uid, p], index) => {
            const hasAnswered = roomData.status === 'answering' && roomData.answers && roomData.answers[uid];
            const betAmount = hasAnswered ? roomData.answers[uid].betAmount : null;
            
            return (
              <div key={uid} className="flex justify-between items-center bg-slate-800/50 px-2 py-1 rounded-lg border border-slate-700/50">
                <div className="flex items-center gap-1.5 overflow-hidden">
                  <span className="text-[10px] sm:text-xs font-black text-slate-500 w-3 sm:w-4 text-center">{index + 1}</span>
                  <div className="flex flex-col">
                    <span className="font-bold text-xs sm:text-sm text-slate-300 truncate max-w-[100px] sm:max-w-[150px]">
                      {p.name} {uid === user.uid && <span className="text-slate-500 text-[8px] sm:text-[10px]">(أنت)</span>}
                    </span>
                    {hasAnswered && (
                      <span className="text-[8px] sm:text-[10px] text-blue-400 font-bold">
                        راهن بـ {betAmount} نقطة
                      </span>
                    )}
                  </div>
                </div>
                <span className="font-black text-yellow-500 text-xs sm:text-sm" dir="ltr">{p.score}</span>
              </div>
            );
          })}
      </div>
    </div>
  );

  return (
    <div className="h-[100dvh] overflow-hidden bg-slate-900 text-white p-1.5 sm:p-4 flex flex-col items-center" dir="rtl">
      <div className="w-full max-w-5xl flex justify-between items-center mb-1.5 sm:mb-2 mt-0.5 sm:mt-1 shrink-0">
        <div className="flex items-center gap-1.5 sm:gap-2 bg-slate-800 px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg sm:rounded-xl border border-slate-700 shadow-lg">
          <span className="text-slate-400 text-xs hidden sm:inline">كود الغرفة:</span>
          <span className="font-mono font-bold text-blue-400 tracking-widest text-sm sm:text-base" dir="ltr">{roomId}</span>
          <button onClick={() => navigator.clipboard.writeText(roomId)} className="text-slate-400 hover:text-white bg-slate-700 p-1 sm:p-1.5 rounded-md sm:rounded-lg transition-colors">
            <Copy className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </button>
        </div>
        <button onClick={leaveRoom} className="flex items-center gap-1 sm:gap-1.5 text-slate-400 hover:text-red-400 transition-colors font-bold bg-slate-800 px-2 sm:px-3 py-1.5 sm:py-2 rounded-lg sm:rounded-xl border border-slate-700">
          <span className="hidden sm:inline text-sm">مغادرة</span>
          <ArrowRight className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>
      </div>

      <div className="w-full max-w-5xl flex-1 flex flex-col lg:grid lg:grid-cols-4 gap-2 sm:gap-4 overflow-hidden">
        {/* Scoreboard Sidebar */}
        <div className={cn(
          "lg:col-span-1 bg-slate-800 rounded-2xl border border-slate-700 p-3 shadow-xl order-2 lg:order-1 overflow-y-auto shrink-0 max-h-[25vh] lg:max-h-full",
          (roomData.status !== 'waiting' && roomData.status !== 'finished') ? "hidden lg:block" : "block"
        )}>
          <h3 className="font-black text-base mb-3 flex items-center gap-2 border-b border-slate-700 pb-2">
            <Trophy className="w-5 h-5 text-yellow-400" />
            النتائج
          </h3>
          <div className="space-y-2">
            {roomData.playerOrder.map(uid => {
              const p = roomData.players[uid];
              const isCurrentAsker = roomData.gameMode === 'custom' && uid === currentAskerId;
              return (
                <div key={uid} className={cn("flex justify-between items-center p-3 rounded-xl transition-all", isCurrentAsker ? "bg-blue-500/20 border border-blue-500/30" : "bg-slate-900 border border-slate-800")}>
                  <div className="flex flex-col">
                    <span className="font-bold truncate max-w-[100px] sm:max-w-[150px] lg:max-w-[100px]">{p.name} {uid === user.uid && <span className="text-slate-500 text-xs">(أنت)</span>}</span>
                    {isCurrentAsker && <span className="text-xs text-blue-400 font-bold mt-1">السائل الحالي</span>}
                    {roomData.gameMode === 'auto' && uid === roomData.hostId && <span className="text-xs text-purple-400 font-bold mt-1">المضيف</span>}
                  </div>
                  <span className="font-black text-yellow-400 bg-slate-800 px-3 py-1 rounded-lg" dir="ltr">{p.score}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Main Game Area */}
        <div className="lg:col-span-3 bg-slate-800 rounded-2xl border border-slate-700 p-2 sm:p-6 shadow-xl order-1 lg:order-2 flex-1 flex flex-col overflow-y-auto">
          
          <div className="mb-2 flex justify-between items-center border-b border-slate-700 pb-2 shrink-0">
            <span className={cn("px-3 sm:px-4 py-1 sm:py-1.5 rounded-full text-xs sm:text-sm font-bold", roomData.gameMode === 'auto' ? "bg-purple-500/20 text-purple-300 border border-purple-500/30" : "bg-blue-500/20 text-blue-300 border border-blue-500/30")}>
              {roomData.gameMode === 'auto' ? 'تحدي أصدقائك' : 'اسأل صديقك'}
            </span>
            {roomData.gameMode === 'auto' && (
              <span className="text-slate-400 font-bold text-xs sm:text-sm bg-slate-900 px-3 sm:px-4 py-1 sm:py-1.5 rounded-full border border-slate-700">
                {roomData.isDecisive ? 'السؤال الحاسم' : `سؤال ${Math.min((roomData.askedQuestions?.length || 0) + (roomData.status === 'answering' || roomData.status === 'judging' ? 1 : 0), 20)} / 20`}
              </span>
            )}
          </div>

          <div className="flex-1 flex flex-col justify-center">
          {roomData.status === 'finished' && (
            <div className="text-center py-12 animate-in fade-in zoom-in duration-500">
              <div className="bg-yellow-500/20 w-32 h-32 rounded-full flex items-center justify-center mx-auto mb-6 border-4 border-yellow-500/50 shadow-[0_0_50px_rgba(234,179,8,0.3)]">
                <Trophy className="w-16 h-16 text-yellow-400" />
              </div>
              <h2 className="text-4xl font-black mb-4 text-white">انتهى التحدي!</h2>
              <p className="text-xl text-slate-300 mb-8">
                الفائز هو <span className="text-yellow-400 font-bold text-3xl block mt-2">{winner?.name}</span>
                <span className="block mt-2 text-slate-400 text-lg">برصيد {winner?.score} نقطة</span>
              </p>
              
              <div className="flex flex-col sm:flex-row gap-4 justify-center mt-12">
                <button 
                  onClick={leaveRoom}
                  className="bg-slate-700 hover:bg-slate-600 text-white py-4 px-8 rounded-2xl font-bold text-lg transition-all active:scale-95"
                >
                  العودة للوبي
                </button>
                {isHost && (
                  <button 
                    onClick={() => {
                      updateDoc(doc(db, 'rooms', roomId), {
                        status: 'waiting',
                        askedQuestions: [],
                        answers: {},
                        currentQuestion: '',
                        currentQuestionData: null,
                        isDecisive: false,
                        players: Object.fromEntries(Object.entries(roomData.players as Record<string, PlayerData>).map(([k, v]) => [k, { ...v, score: 0, usedBets: [] }]))
                      });
                    }}
                    className="bg-green-500 hover:bg-green-600 text-white py-4 px-8 rounded-2xl font-bold text-lg transition-all active:scale-95 shadow-lg shadow-green-500/20"
                  >
                    بدء تحدي جديد
                  </button>
                )}
              </div>
            </div>
          )}

          {roomData.status === 'waiting' && (
            <div className="text-center py-4 sm:py-12">
              <div className="bg-slate-900 w-16 h-16 sm:w-24 sm:h-24 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6 border-4 border-slate-800">
                <Users className="w-8 h-8 sm:w-12 sm:h-12 text-slate-400" />
              </div>
              <h2 className="text-2xl sm:text-3xl font-black mb-2 sm:mb-3">في انتظار اللاعبين...</h2>
              <p className="text-slate-400 mb-6 sm:mb-10 text-base sm:text-lg">انضم <span className="text-white font-bold">{roomData.playerOrder.length}</span> لاعب(ين).</p>
              {isHost ? (
                <div className="space-y-4 sm:space-y-8">
                  <div className="bg-slate-900 p-4 sm:p-6 rounded-2xl border border-slate-700 max-w-sm mx-auto">
                    <h3 className="text-base sm:text-lg font-bold mb-3 sm:mb-4 text-slate-300">وقت الإجابة</h3>
                    <div className="flex gap-2 sm:gap-4 justify-center">
                      <button
                        onClick={() => updateDoc(doc(db, 'rooms', roomId!), { roundTime: 15 })}
                        className={`flex-1 py-2 sm:py-3 rounded-xl font-bold transition-all ${roomData.roundTime === 15 ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/30' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                      >
                        15 ثانية
                      </button>
                      <button
                        onClick={() => updateDoc(doc(db, 'rooms', roomId!), { roundTime: 20 })}
                        className={`flex-1 py-2 sm:py-3 rounded-xl font-bold transition-all ${roomData.roundTime === 20 ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/30' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}
                      >
                        20 ثانية
                      </button>
                    </div>
                  </div>
                  <button onClick={startGame} className="bg-green-500 hover:bg-green-600 text-white py-3 sm:py-4 px-8 sm:px-12 rounded-2xl font-black text-lg sm:text-xl transition-all active:scale-95 flex items-center gap-2 sm:gap-3 mx-auto shadow-xl shadow-green-500/20">
                    <Play className="w-5 h-5 sm:w-6 sm:h-6" />
                    ابدأ اللعبة
                  </button>
                </div>
              ) : (
                <div className="space-y-4 sm:space-y-6">
                  <div className="bg-slate-900 inline-block px-6 sm:px-8 py-3 sm:py-4 rounded-2xl border border-slate-700">
                    <p className="text-slate-300 font-bold">وقت الإجابة: <span className="text-blue-400">{roomData.roundTime || 15} ثانية</span></p>
                  </div>
                  <div className="bg-slate-900 inline-block px-6 sm:px-8 py-3 sm:py-4 rounded-2xl border border-slate-700">
                    <p className="text-yellow-400 font-bold animate-pulse">في انتظار المضيف لبدء اللعبة...</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {roomData.status === 'asking' && (
            <div className="py-4 sm:py-8">
              {roomData.gameMode === 'custom' ? (
                isAsker ? (
                  <form onSubmit={submitQuestion} className="space-y-3 sm:space-y-4">
                    <h2 className="text-xl sm:text-2xl font-bold mb-2 sm:mb-4 text-blue-400">دورك لتسأل!</h2>
                    <p className="text-sm sm:text-base text-slate-400 mb-2 sm:mb-4">اكتب سؤالاً كروياً لباقي اللاعبين.</p>
                    <textarea
                      value={questionInput}
                      onChange={(e) => setQuestionInput(e.target.value)}
                      placeholder="مثال: من فاز بكأس العالم 2010؟"
                      className="w-full bg-slate-900 border border-slate-600 rounded-xl sm:rounded-2xl p-4 sm:p-5 text-white focus:outline-none focus:border-blue-500 min-h-[120px] sm:min-h-[150px] text-base sm:text-lg resize-none"
                      required
                    />
                    <button type="submit" className="w-full bg-blue-500 hover:bg-blue-600 py-3 sm:py-4 rounded-xl sm:rounded-2xl font-bold text-base sm:text-lg transition-all active:scale-95 shadow-lg shadow-blue-500/20">
                      إرسال السؤال
                    </button>
                  </form>
                ) : (
                  <div className="text-center py-8 sm:py-12">
                    <div className="animate-spin rounded-full h-8 w-8 sm:h-10 sm:w-10 border-t-2 border-b-2 border-blue-500 mx-auto mb-3 sm:mb-4"></div>
                    <h2 className="text-lg sm:text-xl font-bold">في انتظار {askerName} ليكتب السؤال...</h2>
                  </div>
                )
              ) : (
                // Auto Mode Asking State
                isHost ? (
                  <div className="text-center py-8 sm:py-12 space-y-4 sm:space-y-6">
                    <Dices className="w-12 h-12 sm:w-16 sm:h-16 mx-auto text-purple-400" />
                    <h2 className="text-xl sm:text-2xl font-bold">اسحب سؤالاً جديداً</h2>
                    <p className="text-sm sm:text-base text-slate-400">سيتم اختيار سؤال عشوائي من قاعدة البيانات.</p>
                    <button onClick={fetchNextQuestion} className="bg-purple-600 hover:bg-purple-700 text-white py-3 sm:py-4 px-6 sm:px-8 rounded-xl font-bold text-base sm:text-lg transition-colors mx-auto block shadow-lg shadow-purple-500/20">
                      بدء التحدي
                    </button>
                  </div>
                ) : (
                  <div className="text-center py-8 sm:py-12">
                    <div className="animate-spin rounded-full h-8 w-8 sm:h-10 sm:w-10 border-t-2 border-b-2 border-purple-500 mx-auto mb-3 sm:mb-4"></div>
                    <h2 className="text-lg sm:text-xl font-bold">في انتظار المضيف لسحب السؤال التالي...</h2>
                  </div>
                )
              )}
            </div>
          )}

          {roomData.status === 'decisive_setup' && (
            <div className="py-2 sm:py-4 flex-1 flex flex-col justify-center">
              {isHost ? (
                <div className="text-center space-y-4 sm:space-y-6">
                  <div className="bg-yellow-500/20 p-4 sm:p-6 rounded-2xl sm:rounded-3xl border border-yellow-500/50">
                    <h2 className="text-2xl sm:text-3xl font-black text-yellow-400 mb-1 sm:mb-2">السؤال الحاسم!</h2>
                    <p className="text-sm sm:text-base text-slate-300">هذا السؤال بـ 20 نقطة إجبارية للجميع.</p>
                  </div>
                  <h3 className="text-lg sm:text-xl font-bold">اختر مستوى الصعوبة:</h3>
                  <div className="flex gap-3 sm:gap-4 justify-center">
                    <button
                      onClick={() => fetchDecisiveQuestion('متوسط')}
                      className="flex-1 bg-blue-500 hover:bg-blue-600 text-white py-3 sm:py-4 rounded-xl sm:rounded-2xl font-bold text-lg sm:text-xl transition-all active:scale-95 shadow-lg shadow-blue-500/20"
                    >
                      متوسط
                    </button>
                    <button
                      onClick={() => fetchDecisiveQuestion('صعب')}
                      className="flex-1 bg-red-500 hover:bg-red-600 text-white py-3 sm:py-4 rounded-xl sm:rounded-2xl font-bold text-lg sm:text-xl transition-all active:scale-95 shadow-lg shadow-red-500/20"
                    >
                      صعب
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8 sm:py-12">
                  <div className="animate-spin rounded-full h-8 w-8 sm:h-10 sm:w-10 border-t-2 border-b-2 border-yellow-500 mx-auto mb-3 sm:mb-4"></div>
                  <h2 className="text-xl sm:text-2xl font-black text-yellow-400 mb-1 sm:mb-2">السؤال الحاسم!</h2>
                  <p className="text-sm sm:text-base text-slate-300">في انتظار المضيف لاختيار مستوى الصعوبة...</p>
                </div>
              )}
            </div>
          )}

          {roomData.status === 'answering' && (
            <div className="py-1 sm:py-2 flex-1 flex flex-col">
              <div className="bg-slate-900 p-3 sm:p-4 rounded-xl sm:rounded-2xl border border-slate-700 mb-2 relative overflow-hidden shadow-inner shrink-0">
                <div className="absolute top-0 right-0 w-full h-1.5 bg-slate-800">
                  <div className="h-full bg-blue-500 transition-all duration-1000 ease-linear" style={{ width: `${(timeLeft / (roomData.roundTime || 15)) * 100}%` }}></div>
                </div>
                <div className="flex justify-between items-center mb-1.5 sm:mb-2">
                  <div className="flex items-center gap-1 text-yellow-400 font-mono font-black text-lg sm:text-xl bg-slate-800 px-2 sm:px-3 py-0.5 sm:py-1 rounded-lg border border-slate-700" dir="ltr">
                    <Clock className="w-4 h-4 sm:w-5 sm:h-5" />
                    {timeLeft}s
                  </div>
                  {roomData.isDecisive && (
                    <span className="text-yellow-400 font-bold text-xs sm:text-sm bg-yellow-500/10 px-2 sm:px-3 py-0.5 sm:py-1 rounded-lg border border-yellow-500/20 animate-pulse">السؤال الحاسم (20 نقطة)</span>
                  )}
                  {!roomData.isDecisive && <span className="text-blue-400 font-bold text-[10px] sm:text-xs bg-blue-500/10 px-2 py-0.5 sm:py-1 rounded-lg border border-blue-500/20">سؤال من: {askerName}</span>}
                </div>
                <h2 className="text-base sm:text-xl font-black leading-snug text-white">{roomData.currentQuestion}</h2>
              </div>

              {roomData.gameMode === 'custom' && isAsker ? (
                <div className="flex-1 flex flex-col gap-1.5 sm:gap-2 min-h-0">
                  <div className="text-center py-4 shrink-0 flex items-center justify-center bg-slate-900 rounded-xl border border-slate-700">
                    <p className="text-slate-400 text-sm sm:text-base">اللاعبون يقومون بالإجابة الآن...</p>
                  </div>
                  {playerListPanel}
                </div>
              ) : (
                roomData.answers[user.uid] ? (
                  <div className="flex-1 flex flex-col gap-1.5 sm:gap-2 min-h-0">
                    <div className="text-center py-4 sm:py-6 bg-slate-900 rounded-xl border border-green-500/30 shrink-0 flex flex-col items-center justify-center">
                      <Check className="w-8 h-8 sm:w-10 sm:h-10 text-green-400 mx-auto mb-1" />
                      <h3 className="text-base sm:text-lg font-bold text-green-400">تم إرسال إجابتك!</h3>
                      <p className="text-slate-400 mt-1 text-xs sm:text-sm">في انتظار انتهاء الوقت...</p>
                    </div>
                    {playerListPanel}
                  </div>
                ) : (
                  <form onSubmit={submitAnswer} className="flex-1 flex flex-col gap-1.5 sm:gap-2 min-h-0">
                    <div className="shrink-0">
                      {roomData.gameMode === 'auto' && roomData.currentQuestionData?.options ? (
                        <div className="grid grid-cols-2 gap-1.5 sm:gap-2">
                          {roomData.currentQuestionData.options.map(opt => (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => setAnswerInput(opt)}
                              className={cn(
                                "p-2 sm:p-3 rounded-xl border-2 text-center transition-all font-bold text-xs sm:text-sm active:scale-95 min-h-[3rem] sm:min-h-[3.5rem] flex items-center justify-center", 
                                answerInput === opt ? "border-blue-500 bg-blue-500/20 text-white shadow-md shadow-blue-500/20" : "border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:border-slate-500"
                              )}
                            >
                              <span className="line-clamp-2">{opt}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <input
                          type="text"
                          value={answerInput}
                          onChange={(e) => setAnswerInput(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-600 rounded-xl p-2.5 sm:p-3 text-white focus:outline-none focus:border-blue-500 text-sm sm:text-base"
                          placeholder="اكتب إجابتك هنا..."
                          required
                        />
                      )}
                    </div>
                    
                    {!roomData.isDecisive && (
                      <div className="bg-slate-900 p-2 sm:p-3 rounded-xl sm:rounded-2xl border border-slate-700 shrink-0">
                        <label className="block text-xs sm:text-sm font-bold text-slate-300 mb-1.5 sm:mb-2 text-center">
                          اختر رقم الرهان (1-20)
                        </label>
                        <div className="grid grid-cols-5 gap-1 sm:gap-1.5" dir="ltr">
                          {Array.from({ length: 20 }, (_, i) => i + 1).map(num => {
                            const isUsed = roomData.players[user.uid]?.usedBets?.includes(num);
                            const isSelected = selectedBet === num;
                            return (
                              <button
                                key={num}
                                type="button"
                                disabled={isUsed}
                                onClick={() => setSelectedBet(num)}
                                className={cn(
                                  "py-1 sm:py-1.5 rounded-lg font-black transition-all text-xs sm:text-sm active:scale-95",
                                  isUsed ? "bg-slate-800 text-slate-600 cursor-not-allowed border border-slate-700" :
                                  isSelected ? "bg-yellow-500 text-slate-900 shadow-md shadow-yellow-500/30 scale-110 z-10" : "bg-slate-700 hover:bg-slate-600 text-white border border-slate-600"
                                )}
                              >
                                {num}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {playerListPanel}

                    <div className="mt-auto pt-1 sm:pt-2 shrink-0">
                      <button 
                        type="submit" 
                        disabled={!answerInput.trim() || (!roomData.isDecisive && !selectedBet)}
                        className="w-full bg-green-500 hover:bg-green-600 disabled:bg-slate-700 disabled:text-slate-500 py-2.5 sm:py-3 rounded-xl font-black text-base sm:text-lg transition-all active:scale-95 shadow-lg shadow-green-500/20"
                      >
                        إرسال الإجابة {roomData.isDecisive ? '(20 نقطة)' : 'والرهان'}
                      </button>
                    </div>
                  </form>
                )
              )}
            </div>
          )}

          {roomData.status === 'judging' && (
            <div className="py-2 sm:py-4">
              <div className="bg-slate-900 p-4 sm:p-6 rounded-2xl sm:rounded-3xl border border-slate-700 mb-4 sm:mb-8">
                <span className="text-slate-400 text-xs sm:text-sm font-bold">السؤال:</span>
                <h2 className="text-lg sm:text-2xl font-black mt-1 sm:mt-2 leading-relaxed">{roomData.currentQuestion}</h2>
              </div>

              {roomData.gameMode === 'auto' || roomData.isDecisive ? (
                <div className="space-y-4 sm:space-y-8">
                  <div className="bg-slate-900 p-4 sm:p-8 rounded-2xl sm:rounded-3xl border-2 border-green-500/30 text-center shadow-[0_0_30px_rgba(34,197,94,0.1)]">
                    <p className="text-slate-400 mb-2 sm:mb-3 font-bold text-sm sm:text-lg">الإجابة الصحيحة هي:</p>
                    <p className="text-2xl sm:text-4xl font-black text-green-400">{roomData.currentQuestionData?.correctAnswer}</p>
                  </div>
                  
                  <div className="space-y-3 sm:space-y-4">
                    <h3 className="font-black text-lg sm:text-xl text-slate-300 mb-3 sm:mb-6 flex items-center gap-2">
                      <Users className="w-5 h-5 sm:w-6 sm:h-6" />
                      إجابات اللاعبين:
                    </h3>
                    {Object.keys(roomData.answers).length === 0 ? (
                      <div className="bg-slate-900 p-6 sm:p-8 rounded-2xl sm:rounded-3xl border border-slate-700 text-center">
                        <p className="text-slate-500 font-bold text-base sm:text-lg">لم يجب أحد في الوقت المحدد!</p>
                      </div>
                    ) : (
                      Object.entries(roomData.answers as Record<string, AnswerData>).map(([uid, ans]) => {
                        const playerName = roomData.players[uid]?.name || 'مجهول';
                        const isCorrect = ans.answerText === roomData.currentQuestionData?.correctAnswer;
                        return (
                          <div key={uid} className={cn("p-4 sm:p-6 rounded-2xl sm:rounded-3xl border-2 flex flex-col sm:flex-row justify-between items-center gap-3 sm:gap-4 transition-all", isCorrect ? "bg-green-500/10 border-green-500/30" : "bg-red-500/10 border-red-500/30")}>
                            <div className="text-center sm:text-right w-full sm:w-auto">
                              <p className="font-black text-white text-base sm:text-lg">{playerName}</p>
                              <p className={cn("text-lg sm:text-xl mt-1 sm:mt-2 font-bold", isCorrect ? "text-green-400" : "text-red-400 line-through decoration-2")}>{ans.answerText}</p>
                            </div>
                            <div className="text-center bg-slate-900 px-6 sm:px-8 py-2 sm:py-3 rounded-xl sm:rounded-2xl border border-slate-700 w-full sm:w-auto">
                              <p className="text-xs sm:text-sm text-slate-400 font-bold mb-1">الرهان</p>
                              <p className="font-mono font-black text-yellow-400 text-2xl sm:text-3xl">{ans.betAmount}</p>
                              {isCorrect && <p className="text-xs sm:text-sm text-green-400 font-black mt-1">+{ans.betAmount}</p>}
                            </div>
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              ) : (
                // Custom Mode Judging
                isAsker ? (
                  <div className="space-y-4 sm:space-y-6">
                    <h3 className="font-black text-lg sm:text-xl text-blue-400 mb-4 sm:mb-6 flex items-center gap-2">
                      <Check className="w-5 h-5 sm:w-6 sm:h-6" />
                      قيّم الإجابات:
                    </h3>
                    {Object.keys(roomData.answers).length === 0 ? (
                      <div className="bg-slate-900 p-6 sm:p-8 rounded-2xl sm:rounded-3xl border border-slate-700 text-center">
                        <p className="text-slate-500 font-bold text-base sm:text-lg">لم يجب أحد في الوقت المحدد!</p>
                      </div>
                    ) : (
                      Object.entries(roomData.answers as Record<string, AnswerData>).map(([uid, ans]) => {
                        const playerName = roomData.players[uid]?.name || 'مجهول';
                        const isCorrect = judgments[uid];
                        return (
                          <div key={uid} className="bg-slate-900 p-4 sm:p-6 rounded-2xl sm:rounded-3xl border border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-4 sm:gap-6">
                            <div className="text-center sm:text-right">
                              <p className="font-black text-blue-400 text-base sm:text-lg">{playerName}</p>
                              <p className="text-lg sm:text-xl mt-1 sm:mt-2 font-bold text-white">{ans.answerText}</p>
                              <p className="text-sm sm:text-base text-yellow-400 mt-2 font-mono font-bold bg-slate-800 inline-block px-2 sm:px-3 py-1 rounded-lg border border-slate-700">الرهان: {ans.betAmount}</p>
                            </div>
                            <div className="flex gap-2 sm:gap-3 shrink-0 w-full sm:w-auto mt-2 sm:mt-0">
                              <button 
                                onClick={() => setJudgments(prev => ({ ...prev, [uid]: true }))}
                                className={cn("flex-1 sm:flex-none px-4 sm:px-6 py-3 sm:py-4 rounded-xl sm:rounded-2xl font-black transition-all active:scale-95 flex items-center justify-center gap-1 sm:gap-2 text-base sm:text-lg", isCorrect === true ? "bg-green-500 text-white shadow-lg shadow-green-500/20" : "bg-slate-800 text-slate-400 hover:bg-green-500/20 hover:text-green-400 border border-slate-700")}
                              >
                                <Check className="w-5 h-5 sm:w-6 sm:h-6" /> صح
                              </button>
                              <button 
                                onClick={() => setJudgments(prev => ({ ...prev, [uid]: false }))}
                                className={cn("flex-1 sm:flex-none px-4 sm:px-6 py-3 sm:py-4 rounded-xl sm:rounded-2xl font-black transition-all active:scale-95 flex items-center justify-center gap-1 sm:gap-2 text-base sm:text-lg", isCorrect === false ? "bg-red-500 text-white shadow-lg shadow-red-500/20" : "bg-slate-800 text-slate-400 hover:bg-red-500/20 hover:text-red-400 border border-slate-700")}
                              >
                                <X className="w-5 h-5 sm:w-6 sm:h-6" /> خطأ
                              </button>
                            </div>
                          </div>
                        )
                      })
                    )}
                    
                    <button 
                      onClick={endTurn} 
                      className="w-full bg-blue-500 hover:bg-blue-600 py-4 sm:py-5 rounded-xl sm:rounded-2xl font-black text-lg sm:text-xl mt-4 sm:mt-8 shadow-xl shadow-blue-500/20 transition-all active:scale-95"
                    >
                      إنهاء الدور وتحديث النقاط
                    </button>
                  </div>
                ) : (
                  <div className="text-center py-8 sm:py-16">
                    <div className="animate-spin rounded-full h-10 w-10 sm:h-12 sm:w-12 border-t-4 border-b-4 border-blue-500 mx-auto mb-4 sm:mb-6"></div>
                    <h2 className="text-xl sm:text-2xl font-black">في انتظار {askerName} لتقييم الإجابات...</h2>
                    {roomData.answers[user.uid] && (
                      <div className="mt-6 sm:mt-8 inline-block bg-slate-900 px-6 sm:px-8 py-4 sm:py-6 rounded-2xl sm:rounded-3xl border border-slate-700 text-center shadow-inner">
                        <p className="text-xs sm:text-sm text-slate-400 font-bold mb-1 sm:mb-2">إجابتك:</p>
                        <p className="font-black text-xl sm:text-2xl text-white">{roomData.answers[user.uid].answerText}</p>
                        <p className="text-base sm:text-lg text-yellow-400 mt-2 sm:mt-3 font-mono font-bold bg-slate-800 inline-block px-3 sm:px-4 py-1 sm:py-1.5 rounded-lg sm:rounded-xl border border-slate-700">الرهان: {roomData.answers[user.uid].betAmount}</p>
                      </div>
                    )}
                  </div>
                )
              )}
            </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
