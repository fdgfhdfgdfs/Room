import React, { useState, useEffect } from 'react';
import { auth, db, signInWithGoogle, logout } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, setDoc, getDoc, updateDoc, onSnapshot, deleteDoc } from 'firebase/firestore';
import { LogOut, Copy, LogIn, Play, Check, X, Clock, Trophy, ArrowLeft, Users } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type RoomStatus = 'waiting' | 'asking' | 'answering' | 'judging';

interface PlayerData {
  name: string;
  score: number;
  usedBets: number[];
}

interface AnswerData {
  answerText: string;
  betAmount: number;
}

interface RoomData {
  hostId: string;
  status: RoomStatus;
  playerOrder: string[];
  players: Record<string, PlayerData>;
  currentAskerIndex: number;
  currentQuestion: string;
  answers: Record<string, AnswerData>;
  questionStartedAt: number | null;
}

const ROUND_TIME = 16;

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomData, setRoomData] = useState<RoomData | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');

  const [timeLeft, setTimeLeft] = useState(ROUND_TIME);
  const [questionInput, setQuestionInput] = useState('');
  const [answerInput, setAnswerInput] = useState('');
  const [selectedBet, setSelectedBet] = useState<number | null>(null);
  const [judgments, setJudgments] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
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
        setError('Room closed or does not exist.');
      }
    }, (err) => {
      console.error("Error listening to room:", err);
      setError('Connection error.');
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
          if (user?.uid === roomData.playerOrder[roomData.currentAskerIndex]) {
            updateDoc(doc(db, 'rooms', roomId!), { status: 'judging' }).catch(console.error);
          }
        }
      }, 1000);
      return () => clearInterval(interval);
    } else {
      setTimeLeft(ROUND_TIME);
    }
  }, [roomData?.status, roomData?.questionStartedAt, roomId, user, roomData?.currentAskerIndex, roomData?.playerOrder]);

  const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

  const createRoom = async () => {
    if (!user) return;
    setError('');
    const newRoomId = generateRoomCode();
    const roomRef = doc(db, 'rooms', newRoomId);
    
    const initialData: RoomData = {
      hostId: user.uid,
      status: 'waiting',
      playerOrder: [user.uid],
      players: {
        [user.uid]: { name: user.displayName || 'Player', score: 0, usedBets: [] }
      },
      currentAskerIndex: 0,
      currentQuestion: '',
      answers: {},
      questionStartedAt: null
    };

    try {
      await setDoc(roomRef, initialData);
      setRoomId(newRoomId);
    } catch (err) {
      setError('Failed to create room.');
    }
  };

  const joinRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !joinCode.trim()) return;
    setError('');
    const code = joinCode.trim().toUpperCase();
    const roomRef = doc(db, 'rooms', code);
    
    try {
      const roomSnap = await getDoc(roomRef);
      if (!roomSnap.exists()) {
        setError('Room not found.');
        return;
      }
      const data = roomSnap.data() as RoomData;
      
      if (data.status === 'waiting' && !data.playerOrder.includes(user.uid)) {
        await updateDoc(roomRef, {
          playerOrder: [...data.playerOrder, user.uid],
          [`players.${user.uid}`]: { name: user.displayName || 'Player', score: 0, usedBets: [] }
        });
      }
      setRoomId(code);
    } catch (err) {
      setError('Failed to join room.');
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
    await updateDoc(doc(db, 'rooms', roomId), { status: 'asking' });
  };

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
  };

  const submitAnswer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roomId || !user || !answerInput.trim() || !selectedBet) return;
    
    // Prevent submitting if bet is already used
    const usedBets = roomData?.players[user.uid]?.usedBets || [];
    if (usedBets.includes(selectedBet)) {
      alert("You have already used this bet number!");
      return;
    }

    await updateDoc(doc(db, 'rooms', roomId), {
      [`answers.${user.uid}`]: {
        answerText: answerInput.trim(),
        betAmount: selectedBet
      }
    });
  };

  const endTurn = async () => {
    if (!roomId || !roomData) return;
    
    const newPlayers = { ...roomData.players };
    Object.entries(roomData.answers).forEach(([uid, ans]) => {
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

  if (loadingAuth) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center text-white">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center text-white p-4">
        <div className="max-w-md w-full bg-slate-800 p-8 rounded-2xl shadow-2xl border border-slate-700 text-center">
          <Trophy className="w-16 h-16 mx-auto mb-6 text-yellow-400" />
          <h1 className="text-3xl font-bold mb-2">Football Trivia Bet</h1>
          <p className="text-slate-400 mb-8">Multiplayer Quiz & Betting Game</p>
          <button
            onClick={signInWithGoogle}
            className="w-full flex items-center justify-center gap-3 bg-white text-slate-900 py-3 px-4 rounded-xl font-semibold hover:bg-slate-100 transition-colors"
          >
            <LogIn className="w-5 h-5" />
            Sign in with Google
          </button>
        </div>
      </div>
    );
  }

  if (!roomId || !roomData) {
    return (
      <div className="min-h-screen bg-slate-900 text-white p-4 flex flex-col items-center justify-center">
        <div className="absolute top-4 right-4 flex items-center gap-4">
          <span className="text-sm text-slate-400">{user.displayName}</span>
          <button onClick={logout} className="p-2 bg-slate-800 rounded-full hover:bg-slate-700 transition-colors" title="Logout">
            <LogOut className="w-5 h-5 text-red-400" />
          </button>
        </div>

        <div className="max-w-md w-full bg-slate-800 p-8 rounded-2xl shadow-2xl border border-slate-700 text-center">
          <Trophy className="w-12 h-12 mx-auto mb-4 text-yellow-400" />
          <h2 className="text-2xl font-bold mb-8">Game Lobby</h2>

          {error && (
            <div className="bg-red-500/10 border border-red-500/50 text-red-400 p-3 rounded-lg mb-6 text-sm">
              {error}
            </div>
          )}

          <button
            onClick={createRoom}
            className="w-full bg-blue-500 hover:bg-blue-600 text-white py-3 px-4 rounded-xl font-semibold transition-colors mb-6 flex items-center justify-center gap-2"
          >
            <Users className="w-5 h-5" />
            Create New Room
          </button>

          <div className="relative flex py-4 items-center">
            <div className="flex-grow border-t border-slate-600"></div>
            <span className="flex-shrink-0 mx-4 text-slate-400 text-sm">OR</span>
            <div className="flex-grow border-t border-slate-600"></div>
          </div>

          <form onSubmit={joinRoom} className="mt-2">
            <div className="flex gap-2">
              <input
                type="text"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                placeholder="Enter Room Code"
                className="flex-1 bg-slate-900 border border-slate-600 rounded-xl px-4 py-3 text-white placeholder-slate-400 focus:outline-none focus:border-blue-500 uppercase tracking-widest text-center font-mono"
                maxLength={6}
              />
              <button
                type="submit"
                disabled={!joinCode.trim()}
                className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 rounded-xl font-semibold transition-colors"
              >
                Join
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  const isHost = user.uid === roomData.hostId;
  const currentAskerId = roomData.playerOrder[roomData.currentAskerIndex];
  const isAsker = user.uid === currentAskerId;
  const askerName = roomData.players[currentAskerId]?.name || 'Someone';

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 flex flex-col items-center">
      <div className="w-full max-w-4xl flex justify-between items-center mb-8">
        <button onClick={leaveRoom} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
          Leave
        </button>
        <div className="flex items-center gap-4 bg-slate-800 px-4 py-2 rounded-xl border border-slate-700">
          <span className="text-slate-400 text-sm">Room Code:</span>
          <span className="font-mono font-bold text-blue-400 tracking-widest">{roomId}</span>
          <button onClick={() => navigator.clipboard.writeText(roomId)} className="text-slate-400 hover:text-white">
            <Copy className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="w-full max-w-4xl grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Scoreboard Sidebar */}
        <div className="bg-slate-800 rounded-2xl border border-slate-700 p-4 h-fit">
          <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
            <Trophy className="w-5 h-5 text-yellow-400" />
            Scoreboard
          </h3>
          <div className="space-y-3">
            {roomData.playerOrder.map(uid => {
              const p = roomData.players[uid];
              return (
                <div key={uid} className={cn("flex justify-between items-center p-3 rounded-lg", uid === currentAskerId ? "bg-blue-500/20 border border-blue-500/30" : "bg-slate-900")}>
                  <div className="flex flex-col">
                    <span className="font-semibold truncate max-w-[120px]">{p.name} {uid === user.uid && "(You)"}</span>
                    {uid === currentAskerId && <span className="text-xs text-blue-400">Current Asker</span>}
                  </div>
                  <span className="font-bold text-yellow-400">{p.score} pts</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Main Game Area */}
        <div className="md:col-span-2 bg-slate-800 rounded-2xl border border-slate-700 p-6">
          
          {roomData.status === 'waiting' && (
            <div className="text-center py-12">
              <Users className="w-16 h-16 mx-auto mb-4 text-slate-500" />
              <h2 className="text-2xl font-bold mb-2">Waiting for players...</h2>
              <p className="text-slate-400 mb-8">{roomData.playerOrder.length} player(s) joined.</p>
              {isHost ? (
                <button onClick={startGame} className="bg-green-500 hover:bg-green-600 text-white py-3 px-8 rounded-xl font-bold text-lg transition-colors flex items-center gap-2 mx-auto">
                  <Play className="w-5 h-5" />
                  Start Game
                </button>
              ) : (
                <p className="text-yellow-400 animate-pulse">Waiting for host to start the game...</p>
              )}
            </div>
          )}

          {roomData.status === 'asking' && (
            <div className="py-8">
              {isAsker ? (
                <form onSubmit={submitQuestion} className="space-y-4">
                  <h2 className="text-2xl font-bold mb-4 text-blue-400">Your Turn to Ask!</h2>
                  <p className="text-slate-400 mb-4">Write a football question for the other players.</p>
                  <textarea
                    value={questionInput}
                    onChange={(e) => setQuestionInput(e.target.value)}
                    placeholder="e.g., Who won the World Cup in 2010?"
                    className="w-full bg-slate-900 border border-slate-600 rounded-xl p-4 text-white focus:outline-none focus:border-blue-500 min-h-[120px]"
                    required
                  />
                  <button type="submit" className="w-full bg-blue-500 hover:bg-blue-600 py-3 rounded-xl font-bold transition-colors">
                    Send Question
                  </button>
                </form>
              ) : (
                <div className="text-center py-12">
                  <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
                  <h2 className="text-xl font-bold">Waiting for {askerName} to ask a question...</h2>
                </div>
              )}
            </div>
          )}

          {roomData.status === 'answering' && (
            <div className="py-4">
              <div className="bg-slate-900 p-6 rounded-xl border border-slate-700 mb-6 relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-1 bg-slate-800">
                  <div className="h-full bg-blue-500 transition-all duration-1000 ease-linear" style={{ width: `${(timeLeft / ROUND_TIME) * 100}%` }}></div>
                </div>
                <div className="flex justify-between items-start mb-4">
                  <span className="text-blue-400 font-semibold text-sm">Question by {askerName}</span>
                  <div className="flex items-center gap-2 text-yellow-400 font-mono font-bold text-xl">
                    <Clock className="w-5 h-5" />
                    {timeLeft}s
                  </div>
                </div>
                <h2 className="text-2xl font-bold">{roomData.currentQuestion}</h2>
              </div>

              {isAsker ? (
                <div className="text-center py-8">
                  <p className="text-slate-400">Players are answering...</p>
                </div>
              ) : (
                roomData.answers[user.uid] ? (
                  <div className="text-center py-12 bg-slate-900 rounded-xl border border-green-500/30">
                    <Check className="w-12 h-12 text-green-400 mx-auto mb-4" />
                    <h3 className="text-xl font-bold text-green-400">Answer Submitted!</h3>
                    <p className="text-slate-400 mt-2">Waiting for time to run out...</p>
                  </div>
                ) : (
                  <form onSubmit={submitAnswer} className="space-y-6">
                    <div>
                      <label className="block text-sm font-medium text-slate-400 mb-2">Your Answer</label>
                      <input
                        type="text"
                        value={answerInput}
                        onChange={(e) => setAnswerInput(e.target.value)}
                        className="w-full bg-slate-900 border border-slate-600 rounded-xl p-4 text-white focus:outline-none focus:border-blue-500"
                        placeholder="Type your answer here..."
                        required
                      />
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-slate-400 mb-2">
                        Choose your Bet (1-20) <br/>
                        <span className="text-xs text-red-400">Remember: You can only use each number ONCE per game!</span>
                      </label>
                      <div className="grid grid-cols-5 sm:grid-cols-10 gap-2">
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
                                "py-2 rounded font-bold transition-colors text-sm",
                                isUsed ? "bg-slate-800 text-slate-600 cursor-not-allowed" :
                                isSelected ? "bg-yellow-500 text-slate-900" : "bg-slate-700 hover:bg-slate-600 text-white"
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
                      className="w-full bg-green-500 hover:bg-green-600 disabled:bg-slate-700 disabled:text-slate-500 py-4 rounded-xl font-bold text-lg transition-colors"
                    >
                      Submit Answer & Bet
                    </button>
                  </form>
                )
              )}
            </div>
          )}

          {roomData.status === 'judging' && (
            <div className="py-4">
              <div className="bg-slate-900 p-4 rounded-xl border border-slate-700 mb-6">
                <span className="text-slate-400 text-sm">Question:</span>
                <h2 className="text-xl font-bold mt-1">{roomData.currentQuestion}</h2>
              </div>

              {isAsker ? (
                <div className="space-y-4">
                  <h3 className="font-bold text-lg text-blue-400 mb-4">Judge the Answers:</h3>
                  {Object.keys(roomData.answers).length === 0 ? (
                    <p className="text-center text-slate-400 py-8">No one answered in time!</p>
                  ) : (
                    Object.entries(roomData.answers).map(([uid, ans]) => {
                      const playerName = roomData.players[uid]?.name || 'Unknown';
                      const isCorrect = judgments[uid];
                      return (
                        <div key={uid} className="bg-slate-900 p-4 rounded-xl border border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                          <div>
                            <p className="font-bold text-blue-400">{playerName}</p>
                            <p className="text-lg mt-1">{ans.answerText}</p>
                            <p className="text-sm text-yellow-400 mt-1 font-mono">Bet: {ans.betAmount}</p>
                          </div>
                          <div className="flex gap-2 shrink-0">
                            <button 
                              onClick={() => setJudgments(prev => ({ ...prev, [uid]: true }))}
                              className={cn("px-6 py-3 rounded-lg font-bold transition-colors flex items-center gap-2", isCorrect === true ? "bg-green-500 text-white" : "bg-slate-800 text-slate-400 hover:bg-green-500/20 hover:text-green-400")}
                            >
                              <Check className="w-5 h-5" /> Correct
                            </button>
                            <button 
                              onClick={() => setJudgments(prev => ({ ...prev, [uid]: false }))}
                              className={cn("px-6 py-3 rounded-lg font-bold transition-colors flex items-center gap-2", isCorrect === false ? "bg-red-500 text-white" : "bg-slate-800 text-slate-400 hover:bg-red-500/20 hover:text-red-400")}
                            >
                              <X className="w-5 h-5" /> Wrong
                            </button>
                          </div>
                        </div>
                      )
                    })
                  )}
                  
                  <button 
                    onClick={endTurn} 
                    className="w-full bg-blue-500 hover:bg-blue-600 py-4 rounded-xl font-bold text-lg mt-6 shadow-lg shadow-blue-500/20"
                  >
                    End Turn & Update Scores
                  </button>
                </div>
              ) : (
                <div className="text-center py-12">
                  <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
                  <h2 className="text-xl font-bold">Waiting for {askerName} to judge the answers...</h2>
                  {roomData.answers[user.uid] && (
                    <div className="mt-6 inline-block bg-slate-900 px-6 py-3 rounded-xl border border-slate-700 text-left">
                      <p className="text-sm text-slate-400">Your Answer:</p>
                      <p className="font-bold text-lg">{roomData.answers[user.uid].answerText}</p>
                      <p className="text-sm text-yellow-400 mt-1">Bet: {roomData.answers[user.uid].betAmount}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
