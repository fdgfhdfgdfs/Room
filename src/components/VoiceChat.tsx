import React, { useState, useEffect, useRef } from 'react';
import { Mic, MicOff, Loader2 } from 'lucide-react';
import Peer, { MediaConnection } from 'peerjs';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';

interface VoiceChatProps {
  roomId: string;
  userId: string;
  players: Record<string, any>;
}

export function VoiceChat({ roomId, userId, players }: VoiceChatProps) {
  const [isMicOn, setIsMicOn] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState('');
  
  const peerRef = useRef<Peer | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const callsRef = useRef<Record<string, MediaConnection>>({});
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      stopVoiceChat();
    };
  }, []);

  // When players change, check if there are new peers to call
  useEffect(() => {
    if (!isMicOn || !peerRef.current || !localStreamRef.current) return;

    const peer = peerRef.current;
    const localStream = localStreamRef.current;

    Object.entries(players).forEach(([otherUserId, playerData]) => {
      if (otherUserId === userId) return; // Skip self
      
      const otherPeerId = playerData.peerId;
      if (otherPeerId && !callsRef.current[otherPeerId]) {
        // We have a peerId for this user, and we haven't called them yet
        const call = peer.call(otherPeerId, localStream);
        if (call) {
          callsRef.current[otherPeerId] = call;
          call.on('stream', (remoteStream) => {
            setRemoteStreams(prev => ({ ...prev, [otherPeerId]: remoteStream }));
          });
          call.on('close', () => {
            setRemoteStreams(prev => {
              const newStreams = { ...prev };
              delete newStreams[otherPeerId];
              return newStreams;
            });
            delete callsRef.current[otherPeerId];
          });
          call.on('error', (err) => {
             console.error('Call error:', err);
          });
        }
      }
    });
  }, [players, isMicOn, userId]);

  const startVoiceChat = async () => {
    setIsConnecting(true);
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;

      const peer = new Peer();
      peerRef.current = peer;

      peer.on('open', async (id) => {
        // Update our peerId in Firestore
        await updateDoc(doc(db, 'rooms', roomId), {
          [`players.${userId}.peerId`]: id
        });
        setIsMicOn(true);
        setIsConnecting(false);
      });

      peer.on('call', (call) => {
        // Answer incoming call
        call.answer(localStreamRef.current!);
        callsRef.current[call.peer] = call;
        
        call.on('stream', (remoteStream) => {
          setRemoteStreams(prev => ({ ...prev, [call.peer]: remoteStream }));
        });
        
        call.on('close', () => {
          setRemoteStreams(prev => {
            const newStreams = { ...prev };
            delete newStreams[call.peer];
            return newStreams;
          });
          delete callsRef.current[call.peer];
        });
      });

      peer.on('error', (err) => {
        console.error('PeerJS error:', err);
        setError('فشل الاتصال الصوتي');
        setIsConnecting(false);
        stopVoiceChat();
      });

    } catch (err) {
      console.error('Mic error:', err);
      setError('تعذر الوصول للمايكروفون');
      setIsConnecting(false);
    }
  };

  const stopVoiceChat = async () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    
    Object.values(callsRef.current).forEach(call => call.close());
    callsRef.current = {};
    setRemoteStreams({});

    if (peerRef.current) {
      peerRef.current.destroy();
      peerRef.current = null;
    }

    setIsMicOn(false);
    setIsConnecting(false);

    // Remove peerId from Firestore
    try {
      await updateDoc(doc(db, 'rooms', roomId), {
        [`players.${userId}.peerId`]: null
      });
    } catch (e) {
      console.error(e);
    }
  };

  const toggleMic = () => {
    if (isMicOn) {
      stopVoiceChat();
    } else {
      startVoiceChat();
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Hidden audio elements for remote streams */}
      {Object.entries(remoteStreams).map(([peerId, stream]) => (
        <AudioPlayer key={peerId} stream={stream} />
      ))}
      
      {error && <span className="text-red-400 text-[10px] sm:text-xs hidden sm:inline">{error}</span>}
      
      <button
        onClick={toggleMic}
        disabled={isConnecting}
        className={`p-1.5 sm:p-2 rounded-lg sm:rounded-xl transition-colors border shadow-lg flex items-center justify-center ${
          isMicOn 
            ? 'bg-green-500/20 border-green-500/50 text-green-400 hover:bg-green-500/30 animate-pulse' 
            : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white hover:bg-slate-700'
        }`}
        title={isMicOn ? 'إيقاف المايك' : 'تشغيل المايك'}
      >
        {isConnecting ? (
          <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" />
        ) : isMicOn ? (
          <Mic className="w-4 h-4 sm:w-5 sm:h-5" />
        ) : (
          <MicOff className="w-4 h-4 sm:w-5 sm:h-5" />
        )}
      </button>
    </div>
  );
}

// Helper component to play audio stream
function AudioPlayer({ stream }: { stream: MediaStream }) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (audioRef.current && stream) {
      audioRef.current.srcObject = stream;
    }
  }, [stream]);

  return <audio ref={audioRef} autoPlay playsInline className="hidden" />;
}
