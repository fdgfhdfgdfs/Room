import React, { useState, useEffect } from 'react';
import { auth, db, signInWithGoogle, logout } from './firebase';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, setDoc, getDoc, updateDoc, onSnapshot, serverTimestamp, deleteDoc } from 'firebase/firestore';
import { LogOut, Copy, RefreshCw, LogIn, Swords, UserPlus, ArrowLeft } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type Player = 'X' | 'O' | null;
type RoomStatus = 'waiting' | 'playing' | 'finished';

interface RoomData {
  hostId: string;
  hostName: string;
  guestId?: string;
  guestName?: string;
  board: Player[];
  turn: 'X' | 'O';
  status: RoomStatus;
  winner?: Player | 'draw';
  createdAt: any;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomData, setRoomData] = useState<RoomData | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');

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

  const generateRoomCode = () => {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  };

  const createRoom = async () => {
    if (!user) return;
    setError('');
    const newRoomId = generateRoomCode();
    const roomRef = doc(db, 'rooms', newRoomId);
    
    const initialData: RoomData = {
      hostId: user.uid,
      hostName: user.displayName || 'Player 1',
      board: Array(9).fill(null),
      turn: 'X',
      status: 'waiting',
      createdAt: serverTimestamp(),
    };

    try {
      await setDoc(roomRef, initialData);
      setRoomId(newRoomId);
    } catch (err) {
      console.error("Error creating room:", err);
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
      
      if (data.status === 'waiting' && data.hostId !== user.uid) {
        await updateDoc(roomRef, {
          guestId: user.uid,
          guestName: user.displayName || 'Player 2',
          status: 'playing'
        });
        setRoomId(code);
      } else if (data.hostId === user.uid || data.guestId === user.uid) {
        // Re-joining own room
        setRoomId(code);
      } else {
        setError('Room is full or already playing.');
      }
    } catch (err) {
      console.error("Error joining room:", err);
      setError('Failed to join room.');
    }
  };

  const leaveRoom = async () => {
    if (!roomId || !user || !roomData) return;
    
    if (roomData.hostId === user.uid) {
      // Host leaves, delete room
      try {
        await deleteDoc(doc(db, 'rooms', roomId));
      } catch (err) {
        console.error("Error deleting room:", err);
      }
    }
    setRoomId(null);
    setRoomData(null);
  };

  const handleCellClick = async (index: number) => {
    if (!roomId || !roomData || !user) return;
    if (roomData.status !== 'playing') return;
    if (roomData.board[index] !== null) return;

    const isHost = user.uid === roomData.hostId;
    const isGuest = user.uid === roomData.guestId;
    
    const mySymbol = isHost ? 'X' : 'O';
    if (roomData.turn !== mySymbol) return; // Not my turn

    const newBoard = [...roomData.board];
    newBoard[index] = mySymbol;

    const winner = checkWinner(newBoard);
    const isDraw = !winner && newBoard.every(cell => cell !== null);

    const roomRef = doc(db, 'rooms', roomId);
    
    try {
      await updateDoc(roomRef, {
        board: newBoard,
        turn: mySymbol === 'X' ? 'O' : 'X',
        ...(winner ? { status: 'finished', winner } : {}),
        ...(isDraw ? { status: 'finished', winner: 'draw' } : {})
      });
    } catch (err) {
      console.error("Error updating board:", err);
    }
  };

  const resetGame = async () => {
    if (!roomId || !roomData || !user) return;
    const roomRef = doc(db, 'rooms', roomId);
    try {
      await updateDoc(roomRef, {
        board: Array(9).fill(null),
        turn: 'X',
        status: 'playing',
        winner: null
      });
    } catch (err) {
      console.error("Error resetting game:", err);
    }
  };

  const checkWinner = (board: Player[]): Player | null => {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
      [0, 4, 8], [2, 4, 6]             // diagonals
    ];
    for (let i = 0; i < lines.length; i++) {
      const [a, b, c] = lines[i];
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        return board[a];
      }
    }
    return null;
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
          <Swords className="w-16 h-16 mx-auto mb-6 text-blue-400" />
          <h1 className="text-3xl font-bold mb-2">Tic-Tac-Toe</h1>
          <p className="text-slate-400 mb-8">Multiplayer Online</p>
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
          <Swords className="w-12 h-12 mx-auto mb-4 text-blue-400" />
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
            <UserPlus className="w-5 h-5" />
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
  const mySymbol = isHost ? 'X' : 'O';
  const opponentName = isHost ? roomData.guestName : roomData.hostName;
  const isMyTurn = roomData.turn === mySymbol;

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 flex flex-col items-center justify-center">
      <div className="absolute top-4 left-4">
        <button onClick={leaveRoom} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors">
          <ArrowLeft className="w-5 h-5" />
          Leave Room
        </button>
      </div>

      <div className="max-w-lg w-full">
        <div className="bg-slate-800 p-6 rounded-2xl shadow-2xl border border-slate-700 mb-6">
          <div className="flex justify-between items-center mb-6">
            <div>
              <p className="text-sm text-slate-400 mb-1">Room Code</p>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-mono font-bold tracking-widest text-blue-400">{roomId}</span>
                <button 
                  onClick={() => navigator.clipboard.writeText(roomId)}
                  className="p-2 hover:bg-slate-700 rounded-lg transition-colors text-slate-400 hover:text-white"
                  title="Copy Code"
                >
                  <Copy className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="text-right">
              <div className="inline-block px-3 py-1 rounded-full text-sm font-medium bg-slate-900 border border-slate-700">
                You are: <span className={cn("font-bold", mySymbol === 'X' ? 'text-blue-400' : 'text-red-400')}>{mySymbol}</span>
              </div>
            </div>
          </div>

          <div className="flex justify-between items-center bg-slate-900 p-4 rounded-xl border border-slate-700">
            <div className="text-center flex-1">
              <p className="font-semibold text-blue-400 truncate px-2">{roomData.hostName}</p>
              <p className="text-xs text-slate-400 mt-1">(X)</p>
            </div>
            <div className="text-slate-500 font-bold px-4">VS</div>
            <div className="text-center flex-1">
              {roomData.guestId ? (
                <>
                  <p className="font-semibold text-red-400 truncate px-2">{roomData.guestName}</p>
                  <p className="text-xs text-slate-400 mt-1">(O)</p>
                </>
              ) : (
                <p className="text-sm text-slate-500 italic animate-pulse">Waiting...</p>
              )}
            </div>
          </div>
        </div>

        {roomData.status === 'waiting' ? (
          <div className="text-center p-12 bg-slate-800 rounded-2xl border border-slate-700 border-dashed">
            <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
            <h3 className="text-xl font-semibold mb-2">Waiting for opponent...</h3>
            <p className="text-slate-400 text-sm">Share the room code with a friend to start playing.</p>
          </div>
        ) : (
          <>
            <div className="text-center mb-6">
              {roomData.status === 'playing' && (
                <div className={cn(
                  "inline-block px-6 py-2 rounded-full font-bold text-lg transition-colors",
                  isMyTurn ? "bg-blue-500/20 text-blue-400 border border-blue-500/50" : "bg-slate-800 text-slate-400 border border-slate-700"
                )}>
                  {isMyTurn ? "Your Turn" : `${opponentName}'s Turn`}
                </div>
              )}
              {roomData.status === 'finished' && (
                <div className="inline-block px-6 py-3 rounded-full font-bold text-xl bg-green-500/20 text-green-400 border border-green-500/50 animate-bounce">
                  {roomData.winner === 'draw' ? "It's a Draw!" : 
                   roomData.winner === mySymbol ? "You Won! 🎉" : `${opponentName} Won!`}
                </div>
              )}
            </div>

            <div className="grid grid-cols-3 gap-3 bg-slate-800 p-4 rounded-2xl border border-slate-700 mx-auto max-w-[350px] aspect-square">
              {roomData.board.map((cell, index) => (
                <button
                  key={index}
                  onClick={() => handleCellClick(index)}
                  disabled={roomData.status !== 'playing' || cell !== null || !isMyTurn}
                  className={cn(
                    "bg-slate-900 rounded-xl text-5xl font-bold flex items-center justify-center transition-all",
                    !cell && roomData.status === 'playing' && isMyTurn && "hover:bg-slate-700 cursor-pointer",
                    cell === 'X' && "text-blue-400 shadow-[inset_0_0_20px_rgba(96,165,250,0.1)]",
                    cell === 'O' && "text-red-400 shadow-[inset_0_0_20px_rgba(248,113,113,0.1)]",
                    (!isMyTurn || cell !== null || roomData.status !== 'playing') && "cursor-default"
                  )}
                >
                  {cell && (
                    <span className="animate-in zoom-in duration-200">
                      {cell}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {roomData.status === 'finished' && (
              <div className="mt-8 text-center">
                <button
                  onClick={resetGame}
                  className="bg-blue-500 hover:bg-blue-600 text-white py-3 px-8 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2 mx-auto"
                >
                  <RefreshCw className="w-5 h-5" />
                  Play Again
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
