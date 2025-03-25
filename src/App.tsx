import { ChangeEvent, useEffect, useRef, useState } from 'react';
import "./App.css";

enum ConnectionStatus {
  Disconnected,
  Connecting,
  Connected,
  ConnectionError
};

type SignalingMessageType = {
  type: string;
};

type ConnectMessage = SignalingMessageType & {
  type: 'connect';
  id: number;
  streamers: number[];
};

type DisconnectedMessage = SignalingMessageType & {
  type: 'streamer-disconnected';
  streamer_id: number;
};

type NewStreamerMessage = SignalingMessageType & {
  type: 'new-streamer';
  streamer_id: number;
};

type OfferMessage = SignalingMessageType & {
  type: 'offer';
  sdp: any;
  sender: number;
};

type CandidateMessage = SignalingMessageType & {
  type: 'ice-candidate';
  candidate: RTCIceCandidate;
  sender: number;
}

const socketPort = import.meta.env.VITE_WS_PORT || "3000";
const socketHost = import.meta.env.VITE_WS_HOST || "localhost";

function ConnectionStatusToStr(cs: ConnectionStatus): string {
  if (cs === ConnectionStatus.Disconnected) {
    return "disconnected";
  } else if (cs === ConnectionStatus.Connecting) {
    return "connecting";
  } else if (cs === ConnectionStatus.Connected) {
    return "connected";
  } else if (cs === ConnectionStatus.ConnectionError) {
    return "connection error";
  } else {
    return "not known";
  }
}

const peerConfig = {
  iceServers: [
    /*    { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      */
  ],
};

const App = () => {
  // Store the peer connections directly in a ref to avoid re-renders
  const streamersRef = useRef<Map<number, RTCPeerConnection>>(new Map());

  // State for UI components
  const [streamerIds, setStreamerIds] = useState<number[]>([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>(ConnectionStatus.Disconnected);
  const [id, setId] = useState(0);

  const webSocketRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null!);
  const logScrollRef = useRef<HTMLDivElement>(null!);

  const log = (new_log: string) => {
    setLogs(prevLogs => [...prevLogs, new_log]);
    console.log(new_log);
  };

  // Update streamer IDs when streamers map changes
  const updateStreamerIds = () => {
    setStreamerIds(Array.from(streamersRef.current.keys()));
  };

  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [logs]);

  const sendToPeer = async (target: number, data: any) => {
    const webSocket = webSocketRef.current;
    if (webSocket && webSocket.readyState === WebSocket.OPEN) {
      const message = {
        ...data,
        target,
      };
      webSocket.send(JSON.stringify(message));
      console.log(`Sent to peer ${target}:`, message);
    } else {
      log(`Cannot send message: WebSocket not connected`);
    }
  };

  const addRemoteVideo = (stream: MediaStream) => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;

      videoRef.current.volume = 1.0;
    }
  };

  const handleConnectMessage = (message: ConnectMessage) => {
    setId(message.id);

    // Process streamer connections
    message.streamers.forEach((streamerId) => {
      if (!streamersRef.current.has(streamerId)) {
        log(`Creating connection with streamer ${streamerId}`);
        const pc = new RTCPeerConnection(peerConfig);
        streamersRef.current.set(streamerId, pc);
      }
    });

    // Update UI
    updateStreamerIds();
    log(`Assigned clientId: ${message.id}`);
  };

  const handleOffer = async (message: OfferMessage) => {
    const streamerId = message.sender;

    log(`Offer received from streamer ${streamerId}`);
    console.log(`Offer received. Current streamers:`, streamersRef.current);

    if (streamersRef.current.has(streamerId)) {
      const pc = streamersRef.current.get(streamerId);
      if (!pc) return;

      try {
        // Setup event listeners first
        pc.addEventListener('icecandidate', (event) => {
          if (event.candidate) {
            console.log("Ice Candidate", event.candidate);
            sendToPeer(streamerId, {
              type: 'ice-candidate',
              candidate: event.candidate,
            });
          }
        });

        pc.addEventListener('connectionstatechange', () => {
          log(`ICE connection state with peer ${streamerId}: ${pc.iceConnectionState}`);
        });

        pc.addEventListener('track', (event) => {
          console.log("Track received:", event);
          addRemoteVideo(event.streams[0]);
        });

        // Process the offer
        await pc.setRemoteDescription(new RTCSessionDescription(message));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        sendToPeer(streamerId, { ...answer, type: "answer" });


      } catch (error) {
        log(`Error processing offer: ${error}`);
        console.error('Error processing offer:', error);
      }
    } else {
      log(`Received offer from unknown streamer ${streamerId}`);
    }
  };

  const handleNewStreamer = (message: NewStreamerMessage) => {
    const streamerId = message.streamer_id;

    if (!streamersRef.current.has(streamerId)) {
      log(`New Streamer ${streamerId}`);
      const pc = new RTCPeerConnection(peerConfig);
      streamersRef.current.set(streamerId, pc);
      updateStreamerIds();
    }
  };

  const handleStreamerDisconnection = (message: DisconnectedMessage) => {
    const streamerId = message.streamer_id;

    if (streamersRef.current.has(streamerId)) {
      const pc = streamersRef.current.get(streamerId);
      pc?.close();
      streamersRef.current.delete(streamerId);
      updateStreamerIds();
      log(`Streamer ${streamerId} disconnected`);
    }
  };

  const handleIceCandidate = async (message: CandidateMessage) => {
    const streamerId = message.sender;

    if (streamersRef.current.has(streamerId)) {
      const pc = streamersRef.current.get(streamerId);
      if (!pc) return;

      try {
        await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
      } catch (error) {
        log(`Error adding ICE candidate: ${error}`);
        console.error('Error adding ICE candidate:', error);
      }
    } else {
      console.log(`Received ICE candidate for unknown streamer ${streamerId}`);
    }
  };

  const handleSignalingMessage = (message: SignalingMessageType) => {
    console.log("Received message:", message);
    console.log("Current streamers:", streamersRef.current);

    switch (message.type) {
      case "connect":
        handleConnectMessage(message as ConnectMessage);
        break;
      case "offer":
        handleOffer(message as OfferMessage);
        break;
      case "new-streamer":
        handleNewStreamer(message as NewStreamerMessage);
        break;
      case "streamer-disconnected":
        handleStreamerDisconnection(message as DisconnectedMessage);
        break;
      case "ice-candidate":
        handleIceCandidate(message as CandidateMessage);
        break;
      default:
        console.log(`Unknown message type: ${message.type}`);
    }
  };

  const handleConnect = () => {
    // If already connecting or connected, disconnect
    const webSocket = webSocketRef.current;
    if (connectionStatus === ConnectionStatus.Connected ||
      connectionStatus === ConnectionStatus.Connecting) {
      // Disconnect logic
      if (webSocket) {
        webSocket.close();
        webSocketRef.current = null;
        setConnectionStatus(ConnectionStatus.Disconnected);

        // Clear all peer connections
        for (const [, pc] of streamersRef.current.entries()) {
          pc.close();
        }
        streamersRef.current.clear();
        updateStreamerIds();

        log("Manually disconnected from signaling server");
        return;
      }
    }

    // Connect logic
    if (connectionStatus === ConnectionStatus.Connecting) return;

    setConnectionStatus(ConnectionStatus.Connecting);

    const timeoutId = setTimeout(() => {
      log("Connection timeout");
      setConnectionStatus(ConnectionStatus.ConnectionError);
    }, 5000);

    try {
      const newSocket = new WebSocket(`ws://${socketHost}:${socketPort}/?role=consumer`);

      newSocket.onopen = () => {
        clearTimeout(timeoutId);
        webSocketRef.current = newSocket;
        setConnectionStatus(ConnectionStatus.Connected);
        log("Connected to signaling server");
      };

      newSocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleSignalingMessage(data);
          log("New message from signaling server");
        } catch (error) {
          log(`Error parsing message: ${error}`);
        }
      };

      newSocket.onclose = () => {
        webSocketRef.current = null;
        setConnectionStatus(ConnectionStatus.Disconnected);
        log("Disconnected from signaling server");
      };

      newSocket.onerror = (error) => {
        clearTimeout(timeoutId);
        log(`WebSocket error: ${error}`);
        setConnectionStatus(ConnectionStatus.ConnectionError);
      };
    } catch (error) {
      clearTimeout(timeoutId);
      log(`Error creating WebSocket: ${error}`);
      setConnectionStatus(ConnectionStatus.ConnectionError);
    }
  };

  const sendSubscribe = (streamerId: number) => {
    if (streamersRef.current.has(streamerId)) {
      // Ensure we have event listeners before subscribing
      const pc = streamersRef.current.get(streamerId);
      if (pc) {
        // Make sure we have all necessary event listeners
        const existingListeners = pc.eventListeners || {};

        if (!existingListeners.icecandidate) {
          pc.addEventListener('icecandidate', (event) => {
            if (event.candidate) {
              sendToPeer(streamerId, {
                type: 'ice-candidate',
                candidate: event.candidate,
              });
            }
          });
        }

        if (!existingListeners.connectionstatechange) {
          pc.addEventListener('connectionstatechange', () => {
            log(`ICE connection state with peer ${streamerId}: ${pc.iceConnectionState}`);
          });
        }

        if (!existingListeners.track) {
          pc.addEventListener('track', (event) => {

            console.log("Track received:", event);
            addRemoteVideo(event.streams[0]);
          });
        }
      }

      // Send subscription request
      sendToPeer(streamerId, {
        type: 'subscribe'
      });
      log(`Subscribe sent to peer ${streamerId}`);
    } else {
      log(`Streamer ${streamerId} not found`);
    }
  };

  const selectStreamer = (event: ChangeEvent<HTMLSelectElement>) => {
    if (event.target && event.target.value && event.target.value.match(/\d+/i)) {
      const streamerId = parseInt(event.target.value);
      log(`Selected streamer ${streamerId}`);
      sendSubscribe(streamerId);
    }
  };

  return (
    <div className="app-container">
      <div className="connection-info">
        <div className="connection-status">
          Connection Status: {ConnectionStatusToStr(connectionStatus)}
        </div>
        <div className="client-info">
          <span>Client ID: {id}</span>
        </div>
        <div>
          {ConnectionStatus.Connected === connectionStatus && (
            <select onChange={selectStreamer}>
              <option>Select streamer</option>
              {streamerIds.map((streamerId) => (
                <option key={streamerId} value={streamerId}>Streamer {streamerId}</option>
              ))}
            </select>
          )}
        </div>
        <button
          onClick={handleConnect}
          className={`connect-button ${connectionStatus === ConnectionStatus.Connected ? 'disconnect' : ''}`}
        >
          {connectionStatus === ConnectionStatus.Connected ? 'Disconnect' : 'Connect'}
        </button>
      </div>

      <div className="video-container">
        <video
          ref={videoRef}
          autoPlay={true}
          playsInline={true}
          controls={true}
          className="remote-video"
        />
      </div>

      <div className="logs-container">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3>Logs:</h3>
          <span>
            <button onClick={() => setLogs([])}>Clear</button>
          </span>
        </div>
        <div className="logs-scroll" ref={logScrollRef}>
          {logs.map((log, index) => (
            <div key={index} className="log-entry">
              {log}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default App;
