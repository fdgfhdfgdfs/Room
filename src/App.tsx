import React, { useState, useEffect } from 'react';
import { auth, db, signInWithGoogle, logout } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, setDoc, getDoc, updateDoc, onSnapshot, deleteDoc, collection, getDocs, addDoc } from 'firebase/firestore';
import { LogOut, Copy, LogIn, Play, Check, X, Clock, Trophy, ArrowRight, Users, Dices, MessageCircleQuestion } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type RoomStatus = 'waiting' | 'asking' | 'answering' | 'judging' | 'finished';
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
      const interval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - roomData.questionStartedAt!) / 1000);
        const remaining = Math.max(0, ROUND_TIME - elapsed);
        setTimeLeft(remaining);

        if (remaining === 0) {
          clearInterval(interval);
          
          // Auto Mode: Host auto-judges when time is up
          if (roomData.gameMode === 'auto' && user?.uid === roomData.hostId) {
            const newPlayers = { ...roomData.players };
            Object.entries(roomData.answers as Record<string, AnswerData>).forEach(([uid, ans]) => {
              const isCorrect = ans.answerText === roomData.currentQuestionData?.correctAnswer;
              newPlayers[uid].usedBets = [...(newPlayers[uid].usedBets || []), ans.betAmount];
              if (isCorrect) {
                newPlayers[uid].score += ans.betAmount;
              }
            });
            
            const newAskedQuestions = [...(roomData.askedQuestions || []), roomData.currentQuestionData!.id];
            const isGameOver = newAskedQuestions.length >= 20;

            updateDoc(doc(db, 'rooms', roomId!), {
              status: isGameOver ? 'finished' : 'judging',
              players: newPlayers,
              askedQuestions: newAskedQuestions
            }).catch(console.error);
          } 
          // Custom Mode: Current asker transitions to judging
          else if (roomData.gameMode === 'custom' && user?.uid === roomData.playerOrder[roomData.currentAskerIndex]) {
            updateDoc(doc(db, 'rooms', roomId!), { status: 'judging' }).catch(console.error);
          }
        }
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setTimeLeft(ROUND_TIME);
    }
  }, [roomData?.status, roomData?.questionStartedAt, roomId, user, roomData?.currentAskerIndex, roomData?.playerOrder, roomData?.gameMode, roomData?.answers, roomData?.currentQuestionData, roomData?.players, roomData?.askedQuestions, roomData?.hostId]);

  // Auto-next question effect for Auto Mode
  useEffect(() => {
    if (roomData?.status === 'judging' && roomData.gameMode === 'auto' && user?.uid === roomData.hostId) {
      const timer = setTimeout(() => {
        fetchNextQuestion();
      }, 5000); // Wait 5 seconds to show the answer, then fetch next
      return () => clearTimeout(timer);
    }
  }, [roomData?.status, roomData?.gameMode, user?.uid, roomData?.hostId]);

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
      questionStartedAt: null
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

  // For Custom Mode
  const submitQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomId || !questionInput.trim()) return;
    await updateDoc(doc(db, 'rooms', roomId), {
      currentQuestion: questionInput.trim(),
      status: 'answering',
      questionStartedAt: Date.now(),
      answers: {}
    });
    setQuestionInput('');
    setAnswerInput('');
    setSelectedBet(null);
  };

  const submitAnswer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomId || !user || !answerInput.trim() || !selectedBet) return;
    
    const usedBets = roomData?.players[user.uid]?.usedBets || [];
    if (usedBets.includes(selectedBet)) {
      alert("لقد استخدمت رقم الرهان هذا من قبل!");
      return;
    }

    await updateDoc(doc(db, 'rooms', roomId), {
      [`answers.${user.uid}`]: {
        answerText: answerInput.trim(),
        betAmount: selectedBet
      }
    });
  };

  // For Custom Mode
  const endTurn = async () => {
    if (!roomId || !roomData) return;
    
    const newPlayers = { ...roomData.players };
    Object.entries(roomData.answers as Record<string, AnswerData>).forEach(([uid, ans]) => {
      const isCorrect = judgments[uid];
      newPlayers[uid].usedBets = [...(newPlayers[uid].usedBets || []), ans.betAmount];
      if (isCorrect) {
        newPlayers[uid].score += ans.betAmount;
      }
    });

    await updateDoc(doc(db, 'rooms', roomId), {
      players: newPlayers,
      status: 'asking',
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

  if (loadingAuth) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white" dir="rtl">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-white p-4" dir="rtl">
        <div className="max-w-md w-full bg-slate-800 p-8 rounded-3xl shadow-2xl border border-slate-700 text-center">
          <div className="bg-slate-900 w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 border-4 border-slate-800 shadow-inner">
            <Trophy className="w-12 h-12 text-yellow-400" />
          </div>
          <h1 className="text-4xl font-black mb-2 tracking-tight">تحدي كرة القدم</h1>
          <p className="text-slate-400 mb-10 text-lg">لعبة أسئلة ورهانات متعددة اللاعبين</p>
          <button
            onClick={handleSignIn}
            disabled={isSigningIn}
            className="w-full flex items-center justify-center gap-3 bg-white text-slate-900 py-4 px-4 rounded-2xl font-bold text-lg hover:bg-slate-100 transition-all active:scale-95 disabled:opacity-70 disabled:cursor-not-allowed shadow-xl shadow-white/10"
          >
            {isSigningIn ? (
              <div className="animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-slate-900"></div>
            ) : (
              <LogIn className="w-6 h-6" />
            )}
            {isSigningIn ? 'جاري تسجيل الدخول...' : 'تسجيل الدخول باستخدام جوجل'}
          </button>
        </div>
      </div>
    );
  }

  if (!isNameSet) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-white p-4" dir="rtl">
        <div className="max-w-md w-full bg-slate-800 p-8 rounded-3xl shadow-2xl border border-slate-700 text-center">
          <h2 className="text-2xl font-bold mb-6">اختر اسمك في اللعبة</h2>
          <form onSubmit={handleSaveName} className="space-y-6">
            <input
              type="text"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="اكتب اسمك هنا..."
              className="w-full bg-slate-900 border border-slate-600 rounded-2xl p-4 text-white focus:outline-none focus:border-blue-500 text-center text-xl font-bold"
              required
              maxLength={15}
            />
            <button
              type="submit"
              disabled={!customName.trim()}
              className="w-full bg-blue-500 hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 py-4 rounded-2xl font-bold text-lg transition-all active:scale-95"
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
      <div className="min-h-screen bg-slate-900 text-white p-4 flex flex-col items-center justify-center" dir="rtl">
        <div className="absolute top-4 left-4 flex items-center gap-4 z-10">
          <button onClick={logout} className="p-3 bg-slate-800 rounded-full hover:bg-slate-700 transition-colors shadow-lg" title="تسجيل الخروج">
            <LogOut className="w-5 h-5 text-red-400" />
          </button>
          <span className="text-sm font-bold text-slate-300 bg-slate-800 px-4 py-2 rounded-full border border-slate-700">{customName}</span>
        </div>

        <div className="max-w-md w-full bg-slate-800 p-6 sm:p-8 rounded-3xl shadow-2xl border border-slate-700 text-center mt-12">
          <div className="bg-slate-900 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 border-4 border-slate-800 shadow-inner">
            <Trophy className="w-10 h-10 text-yellow-400" />
          </div>
          <h2 className="text-3xl font-black mb-8 tracking-tight">صالة اللعب</h2>

          {error && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-4 rounded-xl mb-6 text-sm font-medium">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
            <button
              onClick={() => createRoom('custom')}
              className="bg-slate-700 hover:bg-slate-600 text-white py-5 px-4 rounded-2xl font-bold transition-all active:scale-95 flex flex-col items-center justify-center gap-3 border border-slate-600"
            >
              <MessageCircleQuestion className="w-8 h-8 text-blue-400" />
              <span>اسأل صديقك</span>
              <span className="text-xs text-slate-400 font-normal">تكتب السؤال بنفسك</span>
            </button>
            <button
              onClick={() => createRoom('auto')}
              className="bg-purple-600 hover:bg-purple-700 text-white py-5 px-4 rounded-2xl font-bold transition-all active:scale-95 flex flex-col items-center justify-center gap-3 shadow-lg shadow-purple-500/20"
            >
              <Dices className="w-8 h-8 text-white" />
              <span>تحدي أصدقائك</span>
              <span className="text-xs text-purple-200 font-normal">أسئلة عشوائية من النظام</span>
            </button>
          </div>

          <div className="relative flex py-4 items-center mb-4">
            <div className="flex-grow border-t border-slate-700"></div>
            <span className="flex-shrink-0 mx-4 text-slate-500 text-sm font-bold">أو انضم لغرفة</span>
            <div className="flex-grow border-t border-slate-700"></div>
          </div>

          <form onSubmit={joinRoom}>
            <div className="flex flex-col sm:flex-row gap-3">
              <input
                type="text"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="كود الغرفة"
                className="flex-1 bg-slate-900 border border-slate-600 rounded-2xl px-4 py-4 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 uppercase tracking-widest text-center font-mono text-xl font-bold"
                maxLength={6}
                dir="ltr"
              />
              <button
                type="submit"
                disabled={!joinCode.trim()}
                className="bg-blue-500 hover:bg-blue-600 disabled:bg-slate-700 disabled:text-slate-500 text-white px-8 py-4 rounded-2xl font-bold transition-all active:scale-95 sm:w-auto w-full"
              >
                انضمام
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  const isHost = user.uid === roomData.hostId;
  const currentAskerId = roomData.playerOrder[roomData.currentAskerIndex];
  const isAsker = roomData.gameMode === 'custom' ? user.uid === currentAskerId : isHost;
  const askerName = roomData.gameMode === 'custom' ? (roomData.players[currentAskerId]?.name || 'شخص ما') : 'النظام';

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

  return (
    <div className="min-h-screen bg-slate-900 text-white p-2 sm:p-4 flex flex-col items-center" dir="rtl">
      <div className="w-full max-w-5xl flex justify-between items-center mb-6 mt-2">
        <div className="flex items-center gap-3 bg-slate-800 px-4 py-3 rounded-2xl border border-slate-700 shadow-lg">
          <span className="text-slate-400 text-sm hidden sm:inline">كود الغرفة:</span>
          <span className="font-mono font-bold text-blue-400 tracking-widest text-lg" dir="ltr">{roomId}</span>
          <button onClick={() => navigator.clipboard.writeText(roomId)} className="text-slate-400 hover:text-white bg-slate-700 p-2 rounded-lg transition-colors">
            <Copy className="w-4 h-4" />
          </button>
        </div>
        <button onClick={leaveRoom} className="flex items-center gap-2 text-slate-400 hover:text-red-400 transition-colors font-bold bg-slate-800 px-4 py-3 rounded-2xl border border-slate-700">
          <span className="hidden sm:inline">مغادرة</span>
          <ArrowRight className="w-5 h-5" />
        </button>
      </div>

      <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-4 gap-4 sm:gap-6">
        {/* Scoreboard Sidebar */}
        <div className="lg:col-span-1 bg-slate-800 rounded-3xl border border-slate-700 p-5 h-fit shadow-xl order-2 lg:order-1">
          <h3 className="font-black text-lg mb-5 flex items-center gap-2 border-b border-slate-700 pb-4">
            <Trophy className="w-6 h-6 text-yellow-400" />
            النتائج
          </h3>
          <div className="space-y-3">
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
        <div className="lg:col-span-3 bg-slate-800 rounded-3xl border border-slate-700 p-4 sm:p-8 shadow-xl order-1 lg:order-2 min-h-[60vh] flex flex-col">
          
          <div className="mb-6 flex justify-between items-center border-b border-slate-700 pb-4">
            <span className={cn("px-4 py-1.5 rounded-full text-sm font-bold", roomData.gameMode === 'auto' ? "bg-purple-500/20 text-purple-300 border border-purple-500/30" : "bg-blue-500/20 text-blue-300 border border-blue-500/30")}>
              {roomData.gameMode === 'auto' ? 'تحدي أصدقائك' : 'اسأل صديقك'}
            </span>
            {roomData.gameMode === 'auto' && (
              <span className="text-slate-400 font-bold text-sm bg-slate-900 px-4 py-1.5 rounded-full border border-slate-700">
                سؤال {Math.min((roomData.askedQuestions?.length || 0) + (roomData.status === 'answering' || roomData.status === 'judging' ? 1 : 0), 20)} / 20
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
            <div className="text-center py-12">
              <div className="bg-slate-900 w-24 h-24 rounded-full flex items-center justify-center mx-auto mb-6 border-4 border-slate-800">
                <Users className="w-12 h-12 text-slate-400" />
              </div>
              <h2 className="text-3xl font-black mb-3">في انتظار اللاعبين...</h2>
              <p className="text-slate-400 mb-10 text-lg">انضم <span className="text-white font-bold">{roomData.playerOrder.length}</span> لاعب(ين).</p>
              {isHost ? (
                <button onClick={startGame} className="bg-green-500 hover:bg-green-600 text-white py-4 px-12 rounded-2xl font-black text-xl transition-all active:scale-95 flex items-center gap-3 mx-auto shadow-xl shadow-green-500/20">
                  <Play className="w-6 h-6" />
                  ابدأ اللعبة
                </button>
              ) : (
                <div className="bg-slate-900 inline-block px-8 py-4 rounded-2xl border border-slate-700">
                  <p className="text-yellow-400 font-bold animate-pulse">في انتظار المضيف لبدء اللعبة...</p>
                </div>
              )}
            </div>
          )}

          {roomData.status === 'asking' && (
            <div className="py-8">
              {roomData.gameMode === 'custom' ? (
                isAsker ? (
                  <form onSubmit={submitQuestion} className="space-y-4">
                    <h2 className="text-2xl font-bold mb-4 text-blue-400">دورك لتسأل!</h2>
                    <p className="text-slate-400 mb-4">اكتب سؤالاً كروياً لباقي اللاعبين.</p>
                    <textarea
                      value={questionInput}
                      onChange={(e) => setQuestionInput(e.target.value)}
                      placeholder="مثال: من فاز بكأس العالم 2010؟"
                      className="w-full bg-slate-900 border border-slate-600 rounded-2xl p-5 text-white focus:outline-none focus:border-blue-500 min-h-[150px] text-lg resize-none"
                      required
                    />
                    <button type="submit" className="w-full bg-blue-500 hover:bg-blue-600 py-4 rounded-2xl font-bold text-lg transition-all active:scale-95 shadow-lg shadow-blue-500/20">
                      إرسال السؤال
                    </button>
                  </form>
                ) : (
                  <div className="text-center py-12">
                    <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
                    <h2 className="text-xl font-bold">في انتظار {askerName} ليكتب السؤال...</h2>
                  </div>
                )
              ) : (
                // Auto Mode Asking State
                isHost ? (
                  <div className="text-center py-12 space-y-6">
                    <Dices className="w-16 h-16 mx-auto text-purple-400" />
                    <h2 className="text-2xl font-bold">اسحب سؤالاً جديداً</h2>
                    <p className="text-slate-400">سيتم اختيار سؤال عشوائي من قاعدة البيانات.</p>
                    <button onClick={fetchNextQuestion} className="bg-purple-600 hover:bg-purple-700 text-white py-4 px-8 rounded-xl font-bold text-lg transition-colors mx-auto block shadow-lg shadow-purple-500/20">
                      بدء التحدي
                    </button>
                  </div>
                ) : (
                  <div className="text-center py-12">
                    <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-purple-500 mx-auto mb-4"></div>
                    <h2 className="text-xl font-bold">في انتظار المضيف لسحب السؤال التالي...</h2>
                  </div>
                )
              )}
            </div>
          )}

          {roomData.status === 'answering' && (
            <div className="py-4">
              <div className="bg-slate-900 p-6 sm:p-8 rounded-3xl border border-slate-700 mb-8 relative overflow-hidden shadow-inner">
                <div className="absolute top-0 right-0 w-full h-1.5 bg-slate-800">
                  <div className="h-full bg-blue-500 transition-all duration-1000 ease-linear" style={{ width: `${(timeLeft / ROUND_TIME) * 100}%` }}></div>
                </div>
                <div className="flex justify-between items-center mb-6">
                  <div className="flex items-center gap-2 text-yellow-400 font-mono font-black text-2xl bg-slate-800 px-4 py-2 rounded-xl border border-slate-700" dir="ltr">
                    <Clock className="w-6 h-6" />
                    {timeLeft}s
                  </div>
                  <span className="text-blue-400 font-bold text-sm bg-blue-500/10 px-4 py-2 rounded-xl border border-blue-500/20">سؤال من: {askerName}</span>
                </div>
                <h2 className="text-2xl sm:text-3xl font-black leading-relaxed text-white">{roomData.currentQuestion}</h2>
                
                {roomData.gameMode === 'auto' && roomData.currentQuestionData?.category && (
                  <span className="inline-block mt-6 bg-slate-800 text-slate-300 px-4 py-2 rounded-xl text-sm font-bold border border-slate-600">
                    القسم: {roomData.currentQuestionData.category}
                  </span>
                )}
              </div>

              {roomData.gameMode === 'custom' && isAsker ? (
                <div className="text-center py-8">
                  <p className="text-slate-400">اللاعبون يقومون بالإجابة الآن...</p>
                </div>
              ) : (
                roomData.answers[user.uid] ? (
                  <div className="text-center py-12 bg-slate-900 rounded-xl border border-green-500/30">
                    <Check className="w-12 h-12 text-green-400 mx-auto mb-4" />
                    <h3 className="text-xl font-bold text-green-400">تم إرسال إجابتك!</h3>
                    <p className="text-slate-400 mt-2">في انتظار انتهاء الوقت...</p>
                  </div>
                ) : (
                  <form onSubmit={submitAnswer} className="space-y-6">
                    <div>
                      <label className="block text-sm font-medium text-slate-400 mb-3">إجابتك</label>
                      
                      {roomData.gameMode === 'auto' && roomData.currentQuestionData?.options ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {roomData.currentQuestionData.options.map(opt => (
                            <button
                              key={opt}
                              type="button"
                              onClick={() => setAnswerInput(opt)}
                              className={cn(
                                "p-5 rounded-2xl border-2 text-right transition-all font-bold text-lg active:scale-95", 
                                answerInput === opt ? "border-blue-500 bg-blue-500/20 text-white shadow-lg shadow-blue-500/20" : "border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700 hover:border-slate-500"
                              )}
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <input
                          type="text"
                          value={answerInput}
                          onChange={(e) => setAnswerInput(e.target.value)}
                          className="w-full bg-slate-900 border border-slate-600 rounded-2xl p-5 text-white focus:outline-none focus:border-blue-500 text-lg"
                          placeholder="اكتب إجابتك هنا..."
                          required
                        />
                      )}
                    </div>
                    
                    <div className="bg-slate-900 p-6 rounded-3xl border border-slate-700">
                      <label className="block text-base font-bold text-slate-300 mb-4">
                        اختر رقم الرهان (1-20) <br/>
                        <span className="text-xs text-red-400 font-normal mt-1 block">تذكر: يمكنك استخدام كل رقم مرة واحدة فقط طوال اللعبة!</span>
                      </label>
                      <div className="grid grid-cols-5 sm:grid-cols-10 gap-2 sm:gap-3" dir="ltr">
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
                                "py-3 rounded-xl font-black transition-all text-base sm:text-lg active:scale-95",
                                isUsed ? "bg-slate-800 text-slate-600 cursor-not-allowed border border-slate-700" :
                                isSelected ? "bg-yellow-500 text-slate-900 shadow-lg shadow-yellow-500/30 scale-110 z-10" : "bg-slate-700 hover:bg-slate-600 text-white border border-slate-600"
                              )}
                            >
                              {num}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <button 
                      type="submit" 
                      disabled={!answerInput.trim() || !selectedBet}
                      className="w-full bg-green-500 hover:bg-green-600 disabled:bg-slate-700 disabled:text-slate-500 py-5 rounded-2xl font-black text-xl transition-all active:scale-95 shadow-xl shadow-green-500/20"
                    >
                      إرسال الإجابة والرهان
                    </button>
                  </form>
                )
              )}
            </div>
          )}

          {roomData.status === 'judging' && (
            <div className="py-4">
              <div className="bg-slate-900 p-6 rounded-3xl border border-slate-700 mb-8">
                <span className="text-slate-400 text-sm font-bold">السؤال:</span>
                <h2 className="text-2xl font-black mt-2 leading-relaxed">{roomData.currentQuestion}</h2>
              </div>

              {roomData.gameMode === 'auto' ? (
                <div className="space-y-8">
                  <div className="bg-slate-900 p-8 rounded-3xl border-2 border-green-500/30 text-center shadow-[0_0_30px_rgba(34,197,94,0.1)]">
                    <p className="text-slate-400 mb-3 font-bold text-lg">الإجابة الصحيحة هي:</p>
                    <p className="text-3xl sm:text-4xl font-black text-green-400">{roomData.currentQuestionData?.correctAnswer}</p>
                  </div>
                  
                  <div className="space-y-4">
                    <h3 className="font-black text-xl text-slate-300 mb-6 flex items-center gap-2">
                      <Users className="w-6 h-6" />
                      إجابات اللاعبين:
                    </h3>
                    {Object.keys(roomData.answers).length === 0 ? (
                      <div className="bg-slate-900 p-8 rounded-3xl border border-slate-700 text-center">
                        <p className="text-slate-500 font-bold text-lg">لم يجب أحد في الوقت المحدد!</p>
                      </div>
                    ) : (
                      Object.entries(roomData.answers as Record<string, AnswerData>).map(([uid, ans]) => {
                        const playerName = roomData.players[uid]?.name || 'مجهول';
                        const isCorrect = ans.answerText === roomData.currentQuestionData?.correctAnswer;
                        return (
                          <div key={uid} className={cn("p-5 sm:p-6 rounded-3xl border-2 flex flex-col sm:flex-row justify-between items-center gap-4 transition-all", isCorrect ? "bg-green-500/10 border-green-500/30" : "bg-red-500/10 border-red-500/30")}>
                            <div className="text-center sm:text-right w-full sm:w-auto">
                              <p className="font-black text-white text-lg">{playerName}</p>
                              <p className={cn("text-xl mt-2 font-bold", isCorrect ? "text-green-400" : "text-red-400 line-through decoration-2")}>{ans.answerText}</p>
                            </div>
                            <div className="text-center bg-slate-900 px-8 py-3 rounded-2xl border border-slate-700 w-full sm:w-auto">
                              <p className="text-sm text-slate-400 font-bold mb-1">الرهان</p>
                              <p className="font-mono font-black text-yellow-400 text-3xl">{ans.betAmount}</p>
                              {isCorrect && <p className="text-sm text-green-400 font-black mt-1">+{ans.betAmount}</p>}
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
                  <div className="space-y-6">
                    <h3 className="font-black text-xl text-blue-400 mb-6 flex items-center gap-2">
                      <Check className="w-6 h-6" />
                      قيّم الإجابات:
                    </h3>
                    {Object.keys(roomData.answers).length === 0 ? (
                      <div className="bg-slate-900 p-8 rounded-3xl border border-slate-700 text-center">
                        <p className="text-slate-500 font-bold text-lg">لم يجب أحد في الوقت المحدد!</p>
                      </div>
                    ) : (
                      Object.entries(roomData.answers as Record<string, AnswerData>).map(([uid, ans]) => {
                        const playerName = roomData.players[uid]?.name || 'مجهول';
                        const isCorrect = judgments[uid];
                        return (
                          <div key={uid} className="bg-slate-900 p-5 sm:p-6 rounded-3xl border border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-6">
                            <div className="text-center sm:text-right">
                              <p className="font-black text-blue-400 text-lg">{playerName}</p>
                              <p className="text-xl mt-2 font-bold text-white">{ans.answerText}</p>
                              <p className="text-base text-yellow-400 mt-2 font-mono font-bold bg-slate-800 inline-block px-3 py-1 rounded-lg border border-slate-700">الرهان: {ans.betAmount}</p>
                            </div>
                            <div className="flex gap-3 shrink-0 w-full sm:w-auto">
                              <button 
                                onClick={() => setJudgments(prev => ({ ...prev, [uid]: true }))}
                                className={cn("flex-1 sm:flex-none px-6 py-4 rounded-2xl font-black transition-all active:scale-95 flex items-center justify-center gap-2 text-lg", isCorrect === true ? "bg-green-500 text-white shadow-lg shadow-green-500/20" : "bg-slate-800 text-slate-400 hover:bg-green-500/20 hover:text-green-400 border border-slate-700")}
                              >
                                <Check className="w-6 h-6" /> صح
                              </button>
                              <button 
                                onClick={() => setJudgments(prev => ({ ...prev, [uid]: false }))}
                                className={cn("flex-1 sm:flex-none px-6 py-4 rounded-2xl font-black transition-all active:scale-95 flex items-center justify-center gap-2 text-lg", isCorrect === false ? "bg-red-500 text-white shadow-lg shadow-red-500/20" : "bg-slate-800 text-slate-400 hover:bg-red-500/20 hover:text-red-400 border border-slate-700")}
                              >
                                <X className="w-6 h-6" /> خطأ
                              </button>
                            </div>
                          </div>
                        )
                      })
                    )}
                    
                    <button 
                      onClick={endTurn} 
                      className="w-full bg-blue-500 hover:bg-blue-600 py-5 rounded-2xl font-black text-xl mt-8 shadow-xl shadow-blue-500/20 transition-all active:scale-95"
                    >
                      إنهاء الدور وتحديث النقاط
                    </button>
                  </div>
                ) : (
                  <div className="text-center py-16">
                    <div className="animate-spin rounded-full h-12 w-12 border-t-4 border-b-4 border-blue-500 mx-auto mb-6"></div>
                    <h2 className="text-2xl font-black">في انتظار {askerName} لتقييم الإجابات...</h2>
                    {roomData.answers[user.uid] && (
                      <div className="mt-8 inline-block bg-slate-900 px-8 py-6 rounded-3xl border border-slate-700 text-center shadow-inner">
                        <p className="text-sm text-slate-400 font-bold mb-2">إجابتك:</p>
                        <p className="font-black text-2xl text-white">{roomData.answers[user.uid].answerText}</p>
                        <p className="text-lg text-yellow-400 mt-3 font-mono font-bold bg-slate-800 inline-block px-4 py-1.5 rounded-xl border border-slate-700">الرهان: {roomData.answers[user.uid].betAmount}</p>
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
