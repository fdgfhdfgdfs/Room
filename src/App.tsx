import React, { useState, useEffect } from 'react';
import { auth, db, signInWithGoogle, logout } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
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

  const handleSignIn = async () => {
    if (isSigningIn) return;
    setIsSigningIn(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error(err);
    } finally {
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
             
