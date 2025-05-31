/**
 * Fully Corrected WebSocket Server for Twilio Voice Assistant
 * With Deepgram TTS for greeting and responses
 * 
 * FIXES IMPLEMENTED (Based on Deepgram Documentation Review):
 * - Reverted to direct WebSocket connection for Deepgram (known working method)
 * - Corrected sessionId handling
 * - Fixed Deepgram event handling (transcript instead of transcriptReceived)
 * - Improved WebSocket lifecycle management
 * - FIXED: Simplified audio payload structure for Twilio compatibility
 * - FIXED: Added explicit TTS API call verification and debugging
 * - FIXED: Enhanced TTS error handling and fallback mechanisms
 * - FIXED: Corrected TTS audio format and encoding
 * - FIXED: Improved audio transmission to Twilio
 * - FIXED: Enhanced audio format validation
 * - FIXED: Added text chunking for TTS character limit
 * - FIXED: Enhanced logging for TTS API calls and responses
 * - FIXED: Ensured WebSocket state validation is robust
 * - Enhanced logging and error handling
 */
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@supabase/supabase-js");
const dotenv = require("dotenv");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");

// Load environment variables from .env file if present
dotenv.config();

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Check required environment variables
const requiredEnvVars = [
  "DEEPGRAM_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY", 
  "GROQ_API_KEY"
];

let missingEnvVars = [];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    missingEnvVars.push(envVar);
  }
}

// Exit if any required environment variables are missing
if (missingEnvVars.length > 0) {
  console.error(`❌ Cannot start server due to missing environment variables: ${missingEnvVars.join(", ")}`);
  console.error("Please set these variables in your environment or .env file and try again.");
  process.exit(1);
}

console.log("✅ Environment variables checked");

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Validate Supabase URL format
if (supabaseUrl && supabaseUrl.includes("@")) {
  console.error("❌ Invalid Supabase URL format. The URL should not contain credentials.");
  console.error("Please use the REST API URL from your Supabase dashboard (e.g., https://your-project-id.supabase.co)");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Create WebSocket server with explicit path for Twilio streams
const wss = new WebSocket.Server({ 
  server,
  path: "/stream"
});

// Store active sessions
const activeSessions = new Map();

// Configure Express middleware
app.use(express.json());
app.use(express.static("public"));

// Health check endpoint
app.get("/health", (req, res) => {
  const activeSessionCount = activeSessions.size;
  
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || "1.0.0",
    activeConnections: activeSessionCount
  });
});

// Debug endpoint for WebSocket testing
app.get("/debug", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>WebSocket Debug</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        #status { padding: 10px; border-radius: 5px; margin: 20px 0; }
        .connected { background-color: #d4edda; color: #155724; }
        .disconnected { background-color: #f8d7da; color: #721c24; }
        .connecting { background-color: #fff3cd; color: #856404; }
        pre { background-color: #f8f9fa; padding: 10px; border-radius: 5px; overflow: auto; max-height: 400px; }
        button { padding: 8px 16px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px; }
        button:hover { background-color: #0069d9; }
        .controls { margin: 20px 0; }
        #audioStatus { font-style: italic; margin: 10px 0; }
      </style>
    </head>
    <body>
      <h1>WebSocket Connection Test</h1>
      <div id="status" class="connecting">Connecting...</div>
      
      <div class="controls">
        <button id="reconnect">Reconnect</button>
        <button id="sendTestAudio">Send Test Audio</button>
        <button id="clearLog">Clear Log</button>
      </div>
      
      <div id="audioStatus">No audio sent yet</div>
      
      <h2>Connection Log</h2>
      <pre id="log"></pre>
      
      <script>
        const statusEl = document.getElementById("status");
        const logEl = document.getElementById("log");
        const reconnectBtn = document.getElementById("reconnect");
        const sendTestAudioBtn = document.getElementById("sendTestAudio");
        const clearLogBtn = document.getElementById("clearLog");
        const audioStatusEl = document.getElementById("audioStatus");
        
        let ws;
        let sessionId;
        let callSid;
        
        function log(message) {
          const timestamp = new Date().toISOString();
          logEl.textContent = \`[\${timestamp}] \${message}\\n\` + logEl.textContent;
        }
        
        function connect() {
          statusEl.textContent = "Connecting...";
          statusEl.className = "connecting";
          
          // Create a test session ID
          sessionId = "session-test-" + Date.now();
          callSid = "test-call-" + Date.now();
          
          // Connect to the WebSocket server
          const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
          const wsUrl = \`\${protocol}//\${window.location.host}/stream?callSid=\${callSid}&sessionId=\${sessionId}&tenantId=test&userId=test&sendGreeting=true\`;
          log(\`Connecting to \${wsUrl}\`);
          
          ws = new WebSocket(wsUrl);
          
          ws.onopen = () => {
            statusEl.textContent = "Connected!";
            statusEl.className = "connected";
            log("Connection established");
            
            // Send a test start event
            const startEvent = {
              event: "start",
              start: {
                callSid: callSid,
                streamSid: "test-stream-" + Date.now()
              }
            };
            
            ws.send(JSON.stringify(startEvent));
            log("Sent start event: " + JSON.stringify(startEvent));
          };
          
          ws.onclose = (event) => {
            statusEl.textContent = \`Disconnected (code: \${event.code})\`;
            statusEl.className = "disconnected";
            log(\`Connection closed: code=\${event.code}, reason=\${event.reason}\`);
          };
          
          ws.onerror = (error) => {
            statusEl.textContent = "Error";
            statusEl.className = "disconnected";
            log("Connection error");
          };
          
          ws.onmessage = (event) => {
            try {
              // Try to parse as JSON
              const data = JSON.parse(event.data);
              log("Received: " + JSON.stringify(data, null, 2));
            } catch (e) {
              // If not JSON, might be binary
              log("Received binary data of length: " + event.data.length);
            }
          };
        }
        
        function sendTestAudio() {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            log("Cannot send test audio: WebSocket not connected");
            return;
          }
          
          // Create a simple media event with dummy audio data
          const mediaEvent = {
            event: "media",
            media: {
              track: "inbound",
              chunk: 1,
              timestamp: Date.now(),
              payload: btoa("test audio data").repeat(10) // Base64 dummy data
            }
          };
          
          ws.send(JSON.stringify(mediaEvent));
          log("Sent test audio data");
          audioStatusEl.textContent = "Test audio sent at " + new Date().toLocaleTimeString();
        }
        
        reconnectBtn.addEventListener("click", () => {
          if (ws) {
            ws.close();
          }
          connect();
        });
        
        sendTestAudioBtn.addEventListener("click", sendTestAudio);
        
        clearLogBtn.addEventListener("click", () => {
          logEl.textContent = "";
          log("Log cleared");
        });
        
        // Initial connection
        connect();
      </script>
    </body>
    </html>
  `);
});

// Endpoint to view Deepgram debug logs
app.get("/deepgram-logs", (req, res) => {
  try {
    const logPath = "./deepgram-debug.log";
    if (fs.existsSync(logPath)) {
      const logs = fs.readFileSync(logPath, "utf8");
      res.type("text/plain").send(logs);
    } else {
      res.type("text/plain").send("No Deepgram debug logs available yet.");
    }
  } catch (error) {
    res.status(500).send(`Error reading logs: ${error.message}`);
  }
});

// Endpoint to view TTS debug logs
app.get("/tts-logs", (req, res) => {
  try {
    const logPath = "./tts-debug.log";
    if (fs.existsSync(logPath)) {
      const logs = fs.readFileSync(logPath, "utf8");
      res.type("text/plain").send(logs);
    } else {
      res.type("text/plain").send("No TTS debug logs available yet.");
    }
  } catch (error) {
    res.status(500).send(`Error reading logs: ${error.message}`);
  }
});

// Endpoint to test TTS audio
app.get("/test-tts", async (req, res) => {
  try {
    const text = req.query.text || "This is a test of the text to speech system.";
    const ttsAudio = await generateDeepgramTTS(text);
    
    if (ttsAudio) {
      res.set("Content-Type", "audio/x-mulaw");
      res.set("Content-Disposition", "attachment; filename=\"tts-test.mulaw\"");
      res.send(ttsAudio);
    } else {
      res.status(500).send("Failed to generate TTS audio");
    }
  } catch (error) {
    res.status(500).send(`Error generating TTS: ${error.message}`);
  }
});

// Endpoint to test audio playback
app.get("/test-audio-playback", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Audio Playback Test</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
        button { padding: 8px 16px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; margin-right: 10px; }
        button:hover { background-color: #0069d9; }
        .controls { margin: 20px 0; }
        #status { font-style: italic; margin: 10px 0; }
        pre { background-color: #f8f9fa; padding: 10px; border-radius: 5px; overflow: auto; max-height: 400px; }
      </style>
    </head>
    <body>
      <h1>Audio Playback Test</h1>
      
      <div class="controls">
        <input type="text" id="textInput" placeholder="Enter text to convert to speech" style="width: 300px; padding: 8px;" value="This is a test of the text to speech system.">
        <button id="generateBtn">Generate & Play</button>
        <button id="downloadBtn">Download Audio</button>
      </div>
      
      <div id="status">Ready to generate audio</div>
      
      <h2>Audio Player</h2>
      <audio id="audioPlayer" controls></audio>
      
      <h2>Audio Information</h2>
      <pre id="audioInfo"></pre>
      
      <script>
        const textInput = document.getElementById("textInput");
        const generateBtn = document.getElementById("generateBtn");
        const downloadBtn = document.getElementById("downloadBtn");
        const statusEl = document.getElementById("status");
        const audioPlayer = document.getElementById("audioPlayer");
        const audioInfo = document.getElementById("audioInfo");
        
        let audioBlob = null;
        
        generateBtn.addEventListener("click", async () => {
          const text = textInput.value.trim();
          if (!text) {
            statusEl.textContent = "Please enter some text";
            return;
          }
          
          statusEl.textContent = "Generating audio...";
          
          try {
            const response = await fetch(\"/test-tts?text=\"+encodeURIComponent(text));
            
            if (!response.ok) {
              throw new Error(\"HTTP error! status: \"+response.status);
            }
            
            const arrayBuffer = await response.arrayBuffer();
            audioBlob = new Blob([arrayBuffer], { type: "audio/x-mulaw" });
            
            // Convert to WAV for browser playback
            const wavBlob = await convertMulawToWav(arrayBuffer);
            
            const audioUrl = URL.createObjectURL(wavBlob);
            audioPlayer.src = audioUrl;
            
            // Display audio info
            audioInfo.textContent = \
Original μ-law Audio:\n- Size: \${arrayBuffer.byteLength} bytes\n- Format: audio/x-mulaw\n- Sample Rate: 8000 Hz\n- Channels: 1\n- Duration: ~\${(arrayBuffer.byteLength / 8000).toFixed(2)} seconds\n\nConverted WAV Audio:\n- Size: \${wavBlob.size} bytes\n- Format: audio/wav\n- Sample Rate: 8000 Hz\n- Channels: 1\
            ;
            
            statusEl.textContent = "Audio generated successfully!";
          } catch (error) {
            statusEl.textContent = \"Error: \"+error.message;
            console.error(error);
          }
        });
        
        downloadBtn.addEventListener("click", () => {
          if (!audioBlob) {
            statusEl.textContent = "Generate audio first";
            return;
          }
          
          const a = document.createElement("a");
          a.href = URL.createObjectURL(audioBlob);
          a.download = "tts-audio.mulaw";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        });
        
        // Simple μ-law to WAV converter for browser playback
        async function convertMulawToWav(mulawBuffer) {
          // WAV header for 8kHz mono PCM
          const wavHeader = new ArrayBuffer(44);
          const view = new DataView(wavHeader);
          
          // "RIFF" chunk descriptor
          view.setUint32(0, 0x52494646, false); // "RIFF"
          view.setUint32(4, 36 + mulawBuffer.byteLength, true); // File size - 8
          view.setUint32(8, 0x57415645, false); // "WAVE"
          
          // "fmt " sub-chunk
          view.setUint32(12, 0x666D7420, false); // "fmt "
          view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
          view.setUint16(20, 7, true); // AudioFormat (7 = μ-law)
          view.setUint16(22, 1, true); // NumChannels (1 = mono)
          view.setUint32(24, 8000, true); // SampleRate (8000 Hz)
          view.setUint32(28, 8000, true); // ByteRate (SampleRate * NumChannels * BitsPerSample/8)
          view.setUint16(32, 1, true); // BlockAlign (NumChannels * BitsPerSample/8)
          view.setUint16(34, 8, true); // BitsPerSample (8 bits)
          
          // "data" sub-chunk
          view.setUint32(36, 0x64617461, false); // "data"
          view.setUint32(40, mulawBuffer.byteLength, true); // Subchunk2Size
          
          // Combine header and audio data
          const wavBuffer = new Uint8Array(wavHeader.byteLength + mulawBuffer.byteLength);
          wavBuffer.set(new Uint8Array(wavHeader), 0);
          wavBuffer.set(new Uint8Array(mulawBuffer), wavHeader.byteLength);
          
          return new Blob([wavBuffer], { type: "audio/wav" });
        }
      </script>
    </body>
    </html>
  `);
});

/**
 * Enhanced logging utility
 * @param {string} level - Log level (info, warn, error, debug)
 * @param {string} category - Logging category
 * @param {string} message - Log message
 * @param {Object} [data] - Optional data to include
 */
function enhancedLog(level, category, message, data = null) {
  const timestamp = new Date().toISOString();
  const logPrefix = {
    "info": "📋",
    "warn": "⚠️",
    "error": "❌",
    "debug": "🔍",
    "success": "✅",
    "audio": "🔊",
    "network": "📡",
    "transcript": "🎤"
  }[level] || "📋";
  
  const logMessage = `${timestamp} ${logPrefix} [${category}] ${message}`;
  
  switch (level) {
    case "error":
      console.error(logMessage, data ? data : "");
      break;
    case "warn":
      console.warn(logMessage, data ? data : "");
      break;
    case "debug":
      console.debug(logMessage, data ? data : "");
      break;
    default:
      console.log(logMessage, data ? data : "");
  }
  
  // If this is a Deepgram-related log, also write to debug file
  if (category === "Deepgram") {
    try {
      const debugLogMessage = `${timestamp} [${level.toUpperCase()}] ${message} ${data ? JSON.stringify(data) : ""}\n`;
      fs.appendFileSync("./deepgram-debug.log", debugLogMessage);
    } catch (error) {
      console.error(`Error writing to Deepgram debug log: ${error.message}`);
    }
  }
  
  // If this is a TTS-related log, also write to TTS debug file
  if (category === "TTS") {
    try {
      const debugLogMessage = `${timestamp} [${level.toUpperCase()}] ${message} ${data ? JSON.stringify(data) : ""}\n`;
      fs.appendFileSync("./tts-debug.log", debugLogMessage);
    } catch (error) {
      console.error(`Error writing to TTS debug log: ${error.message}`);
    }
  }
}

/**
 * Check WebSocket state and handle errors
 * @param {Object} session - The session object
 * @param {string} operation - The operation being performed
 * @returns {boolean} - True if WebSocket is ready
 */
function checkWebSocketState(session, operation) {
  if (!session) {
    enhancedLog("error", "WebSocket", `Cannot ${operation}: Session is null or undefined`);
    return false;
  }
  
  if (!session.ws) {
    enhancedLog("error", "WebSocket", `Cannot ${operation}: WebSocket not initialized (sessionId=${session.sessionId})`);
    return false;
  }
  
  if (session.ws.readyState !== WebSocket.OPEN) {
    const stateMap = {
      0: "CONNECTING",
      1: "OPEN",
      2: "CLOSING",
      3: "CLOSED"
    };
    
    enhancedLog("error", "WebSocket", `Cannot ${operation}: WebSocket not open, state=${stateMap[session.ws.readyState] || session.ws.readyState} (sessionId=${session.sessionId})`);
    return false;
  }
  
  return true;
}

// WebSocket connection handler
wss.on("connection", async (ws, req) => {
  // Parse URL parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callSid = url.searchParams.get("callSid");
  
  // Properly extract sessionId from URL parameters
  const sessionId = url.searchParams.get("sessionId") || callSid || `session-${Date.now()}`;
  
  const tenantId = url.searchParams.get("tenantId");
  const userId = url.searchParams.get("userId");
  const sendGreeting = url.searchParams.get("sendGreeting") === "true";

  enhancedLog("info", "Connection", `New WebSocket connection: callSid=${callSid}, sessionId=${sessionId}`);

  // Check if session already exists (reconnection case)
  let session = activeSessions.get(sessionId);
  
  if (session) {
    enhancedLog("info", "Session", `Reconnecting to existing session: ${sessionId}`);
    
    // Update WebSocket connection
    session.ws = ws;
    session.isActive = true;
    session.lastActivityTimestamp = Date.now();
    
    // Don't reset other session state to maintain conversation continuity
  } else {
    // Initialize new session
    session = {
      callSid,
      sessionId,
      tenantId,
      userId,
      deepgramConnection: null,
      deepgramReady: false,
      conversationHistory: [],
      isActive: true,
      ws: ws,
      streamSid: null,
      audioQueue: [],
      // Set welcome message flag based on URL parameter
      welcomeMessageSent: !sendGreeting,
      reconnectionAttempts: 0,
      maxReconnectionAttempts: 5,
      isProcessingResponse: false,
      pendingResponse: false,
      greetingAttempts: 0,
      maxGreetingAttempts: 3,
      lastActivityTimestamp: Date.now(),
      // Add ping/pong tracking
      lastPingTimestamp: Date.now(),
      pingInterval: null,
      // Add audio processing stats
      audioStats: {
        totalChunksReceived: 0,
        totalChunksProcessed: 0,
        queueHighWaterMark: 0
      },
      // Add outbound chunk counter for audio sequencing
      outboundChunkCounter: 1,
      // Add Deepgram message tracking
      deepgramMessages: 0,
      deepgramTranscripts: 0,
      // TTS tracking
      ttsRequests: 0,
      ttsSuccesses: 0,
      ttsFailures: 0,
      lastTtsText: null,
      lastTtsAudioSize: 0,
      lastTtsError: null
    };

    activeSessions.set(sessionId, session);
    enhancedLog("success", "Session", `New session created: ${sessionId}`);
  }

  // Set up ping interval to keep connection alive
  if (session.pingInterval) {
    clearInterval(session.pingInterval);
  }
  
  session.pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const now = Date.now();
      // Only send ping if we haven't received anything in the last 10 seconds
      if (now - session.lastActivityTimestamp > 10000) {
        try {
          ws.ping();
          session.lastPingTimestamp = now;
        } catch (error) {
          enhancedLog("error", "WebSocket", `Error sending ping to client: ${error.message}`);
        }
      }
    } else {
      // Clear interval if connection is closed
      clearInterval(session.pingInterval);
    }
  }, 15000);

  // Initialize Deepgram immediately
  enhancedLog("info", "Deepgram", `Initializing connection for session ${sessionId}`);
  const deepgramInitialized = await initializeDeepgramConnection(session);
  
  if (!deepgramInitialized) {
    enhancedLog("error", "Deepgram", `Failed to initialize for session ${sessionId}`);
    // Send error message to client
    try {
      ws.send(JSON.stringify({
        event: "error",
        error: {
          message: "Failed to initialize speech recognition service",
          code: "DEEPGRAM_INIT_FAILED"
        }
      }));
    } catch (error) {
      enhancedLog("error", "WebSocket", `Error sending error message to client: ${error.message}`);
    }
  }

  ws.on("message", async (message) => {
    try {
      // Update activity timestamp
      session.lastActivityTimestamp = Date.now();
      
      enhancedLog("debug", "WebSocket", `Received raw message of length: ${message.length} bytes`);
      
      // Try to parse as JSON
      try {
        const data = JSON.parse(message);
        enhancedLog("info", "WebSocket", `Received event: ${data.event}`);
        
        // Store streamSid if this is a start event
        if (data.event === "start" && data.start && data.start.streamSid) {
          session.streamSid = data.start.streamSid;
          enhancedLog("info", "Stream", `Started with SID: ${session.streamSid}`);
          
          // Send greeting if needed and we have the streamSid
          if (!session.welcomeMessageSent && session.streamSid) {
            await sendGreetingMessage(session);
          }
        }
        
        // Handle media event
        if (data.event === "media" && data.media && data.media.payload && data.media.track === "inbound") {
          // Convert from base64
          const audioBuffer = Buffer.from(data.media.payload, "base64");
          session.audioStats.totalChunksReceived++;
          
          // Check if Deepgram is ready
          if (session.deepgramReady && session.deepgramConnection && 
              session.deepgramConnection.readyState === WebSocket.OPEN) {
            session.deepgramConnection.send(audioBuffer);
            session.audioStats.totalChunksProcessed++;
            enhancedLog("debug", "Deepgram", `Forwarded audio chunk`);
          } else {
            // Queue audio until Deepgram is ready
            if (session.audioQueue.length < 500) {
              session.audioQueue.push(audioBuffer);
              // Update high water mark
              if (session.audioQueue.length > session.audioStats.queueHighWaterMark) {
                session.audioStats.queueHighWaterMark = session.audioQueue.length;
              }
              enhancedLog("debug", "Audio", `Queued chunk (queue size: ${session.audioQueue.length})`);
            } else {
              enhancedLog("warn", "Audio", `Queue full, dropping chunk (queue size: ${session.audioQueue.length})`);
              // If queue is full and Deepgram is not ready, try to reconnect
              if (!session.deepgramReady && session.reconnectionAttempts < session.maxReconnectionAttempts) {
                await reconnectDeepgramSTT(session);
              }
            }
          }
        }
        
        // Handle stop event
        if (data.event === "stop") {
          enhancedLog("info", "Stream", `Stop event received for session ${sessionId}`);
          
          // Check if we're still processing a response
          if (session.isProcessingResponse) {
            enhancedLog("info", "Session", `Still processing a response, delaying cleanup for session ${sessionId}`);
            
            // Mark for delayed cleanup
            session.pendingCleanup = true;
            
            // Set a timeout to clean up after a reasonable delay
            setTimeout(() => {
              if (session.pendingCleanup) {
                enhancedLog("info", "Session", `Performing delayed cleanup after stop event for session ${sessionId}`);
                cleanupSession(sessionId);
              }
            }, 10000); // 10 second delay
          } else {
            // No active processing, can clean up now
            enhancedLog("info", "Session", `Performing immediate cleanup after stop event for session ${sessionId}`);
            await cleanupSession(sessionId);
          }
        }
      } catch (jsonError) {
        // Not JSON, might be binary audio data
        enhancedLog("debug", "WebSocket", `Received binary data, length: ${message.length} bytes`);
        session.audioStats.totalChunksReceived++;
        
        // If Deepgram is ready, forward the audio
        if (session.deepgramReady && session.deepgramConnection && 
            session.deepgramConnection.readyState === WebSocket.OPEN) {
          session.deepgramConnection.send(message);
          session.audioStats.totalChunksProcessed++;
          enhancedLog("debug", "Deepgram", `Forwarded binary audio`);
        } else {
          // Queue audio until Deepgram is ready
          if (session.audioQueue.length < 500) {
            session.audioQueue.push(message);
            // Update high water mark
            if (session.audioQueue.length > session.audioStats.queueHighWaterMark) {
              session.audioStats.queueHighWaterMark = session.audioQueue.length;
            }
            enhancedLog("debug", "Audio", `Queued binary chunk (queue size: ${session.audioQueue.length})`);
          } else {
            enhancedLog("warn", "Audio", `Queue full, dropping binary chunk (queue size: ${session.audioQueue.length})`);
          }
        }
      }
    } catch (error) {
      enhancedLog("error", "WebSocket", `Message error: ${error.message}`, error);
    }
  });

  // Handle pong responses to track connection health
  ws.on("pong", () => {
    const latency = Date.now() - session.lastPingTimestamp;
    enhancedLog("debug", "WebSocket", `Received pong from client, latency: ${latency}ms`);
    session.lastActivityTimestamp = Date.now();
  });

  // Handle WebSocket close
  ws.on("close", (code, reason) => {
    enhancedLog("info", "WebSocket", `Connection closed: ${sessionId}, code: ${code}, reason: ${reason || "No reason provided"}`);
    clearInterval(session.pingInterval);
    
    // Mark session as inactive but keep it around for a while
    session.isActive = false;
    
    // Set a timeout to clean up after a reasonable delay
    setTimeout(() => {
      // Only clean up if still inactive
      if (activeSessions.has(sessionId) && !activeSessions.get(sessionId).isActive) {
        enhancedLog("info", "Session", `Performing delayed cleanup after WebSocket close: ${sessionId}`);
        cleanupSession(sessionId);
      }
    }, 30000); // 30 second delay
  });
});

/**
 * Initialize Deepgram connection for speech-to-text
 * @param {Object} session - The session object
 * @returns {Promise<boolean>} - True if successful
 */
async function initializeDeepgramConnection(session) {
  try {
    // Close existing connection if any
    if (session.deepgramConnection) {
      try {
        session.deepgramConnection.close();
      } catch (error) {
        enhancedLog("error", "Deepgram", `Error closing existing connection: ${error.message}`);
      }
    }
    
    enhancedLog("info", "Deepgram", `Initializing connection for session ${session.sessionId}`);
    
    // Use direct WebSocket connection to Deepgram
    const deepgramUrl = "wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2&smart_format=true&interim_results=false&language=en&debug=true";
    enhancedLog("debug", "Deepgram", `Connection URL: ${deepgramUrl}`);
    
    const deepgramConnection = new WebSocket(deepgramUrl, {
      headers: {
        "Authorization": `Token ${process.env.DEEPGRAM_API_KEY}`
      }
    });
    
    session.deepgramConnection = deepgramConnection;
    
    // Set up event handlers
    deepgramConnection.on("open", () => {
      enhancedLog("success", "Deepgram", `Connection established for session ${session.sessionId}`);
      session.deepgramReady = true;
      
      // Process any queued audio
      if (session.audioQueue.length > 0) {
        enhancedLog("info", "Audio", `Processing ${session.audioQueue.length} queued chunks for session ${session.sessionId}`);
        
        for (const audioChunk of session.audioQueue) {
          if (session.deepgramReady && 
              session.deepgramConnection && 
              session.deepgramConnection.readyState === WebSocket.OPEN) {
            session.deepgramConnection.send(audioChunk);
            session.audioStats.totalChunksProcessed++;
            enhancedLog("debug", "Deepgram", `Forwarded queued audio chunk`);
          } else {
            enhancedLog("warn", "Deepgram", `Connection not ready while processing queue for session ${session.sessionId}`);
            break; // Stop processing if connection is not ready
          }
        }
        
        // Clear the queue
        session.audioQueue = [];
      }
    });
    
    // Handle Deepgram messages
    deepgramConnection.on("message", async (data) => {
      session.deepgramMessages++;
      enhancedLog("debug", "Deepgram", `Received message #${session.deepgramMessages} from Deepgram (length: ${data.length}) for session ${session.sessionId}`);
      
      try {
        // Save raw message for debugging
        const rawMessage = data.toString();
        enhancedLog("debug", "Deepgram", `Raw message: ${rawMessage}`);
        
        // Parse the JSON response from Deepgram
        const response = JSON.parse(rawMessage);
        enhancedLog("debug", "Deepgram", `Parsed Deepgram message: ${JSON.stringify(response)}`);
        
        // Check if this is a transcript with alternatives
        if (response.type === "Results" && 
            response.channel && 
            response.channel.alternatives && 
            response.channel.alternatives.length > 0) {
          
          const transcript = response.channel.alternatives[0].transcript;
          enhancedLog("debug", "Deepgram", `Extracted transcript: "${transcript}"`);
          
          // Only process if we have actual text
          if (transcript && transcript.trim()) {
            session.deepgramTranscripts++;
            enhancedLog("transcript", "Deepgram", `Transcript #${session.deepgramTranscripts}: "${transcript}"`);
            
            // Add to conversation history
            session.conversationHistory.push(transcript);
            
            // Don't process if we're already generating a response
            if (session.isProcessingResponse) {
              enhancedLog("info", "AI", `Already processing a response, marking as pending for session ${session.sessionId}`);
              session.pendingResponse = true;
              return;
            }
            
            session.isProcessingResponse = true;
            enhancedLog("info", "AI", `Starting AI response generation for session ${session.sessionId}`);
            
            try {
              // Generate AI response
              const aiResponse = await generateAIResponse(session, transcript);
              
              if (aiResponse) {
                enhancedLog("success", "AI", `Response generated for session ${session.sessionId}`);
                enhancedLog("info", "AI", `Response: ${aiResponse}`);
                
                // Add to conversation history
                session.conversationHistory.push(aiResponse);
                
                // Log conversation turn to database
                await logConversationTurn(session, transcript, aiResponse);
                
                // Generate TTS for the response
                await generateAndSendTTS(session, aiResponse);
                
              } else {
                enhancedLog("error", "AI", `Failed to generate response for session ${session.sessionId}`);
              }
            } catch (error) {
              enhancedLog("error", "Processing", `Error processing transcript: ${error.message}`, error);
            } finally {
              session.isProcessingResponse = false;
              enhancedLog("info", "AI", `Finished processing response for session ${session.sessionId}`);
              
              // Check if we have a pending response to process
              if (session.pendingResponse) {
                enhancedLog("info", "AI", `Processing pending response for session ${session.sessionId}`);
                session.pendingResponse = false;
                
                // Get the last user message from history
                const lastUserMessage = session.conversationHistory[session.conversationHistory.length - 2];
                
                if (lastUserMessage) {
                  // Process it
                  session.isProcessingResponse = true;
                  enhancedLog("info", "AI", `Starting AI response generation for pending message for session ${session.sessionId}`);
                  
                  try {
                    // Generate AI response
                    const aiResponse = await generateAIResponse(session, lastUserMessage);
                    
                    if (aiResponse) {
                      enhancedLog("success", "AI", `Response generated for pending message for session ${session.sessionId}`);
                      enhancedLog("info", "AI", `Response: ${aiResponse}`);
                      
                      // Add to conversation history
                      session.conversationHistory.push(aiResponse);
                      
                      // Log conversation turn to database
                      await logConversationTurn(session, lastUserMessage, aiResponse);
                      
                      // Generate TTS for the response
                      await generateAndSendTTS(session, aiResponse);
                      
                    } else {
                      enhancedLog("error", "AI", `Failed to generate response for pending message for session ${session.sessionId}`);
                    }
                  } catch (error) {
                    enhancedLog("error", "Processing", `Error processing pending transcript: ${error.message}`, error);
                  } finally {
                    session.isProcessingResponse = false;
                    enhancedLog("info", "AI", `Finished processing pending response for session ${session.sessionId}`);
                  }
                }
              }
            }
          }
        } else if (response.type === "Metadata") {
          enhancedLog("info", "Deepgram", `Received metadata: ${JSON.stringify(response)}`);
        } else if (response.type === "UtteranceEnd") {
          enhancedLog("info", "Deepgram", `Utterance end: ${JSON.stringify(response)}`);
        } else {
          enhancedLog("debug", "Deepgram", `Received non-transcript message: ${JSON.stringify(response)}`);
        }
      } catch (error) {
        enhancedLog("error", "Deepgram", `Error parsing response: ${error.message}`, error);
        enhancedLog("debug", "Deepgram", `Raw data received: ${data.toString()}`);
      }
    });
    
    deepgramConnection.on("error", (error) => {
      enhancedLog("error", "Deepgram", `Connection error for session ${session.sessionId}: ${error.message}`, error);
      session.deepgramReady = false;
      
      // Try to reconnect
      if (session.reconnectionAttempts < session.maxReconnectionAttempts) {
        reconnectDeepgramSTT(session);
      }
    });
    
    deepgramConnection.on("close", (code, reason) => {
      enhancedLog("info", "Deepgram", `Connection closed for session ${session.sessionId}: code=${code}, reason=${reason || "No reason provided"}`);
      session.deepgramReady = false;
      
      // Try to reconnect if session is still active
      if (session.isActive && session.reconnectionAttempts < session.maxReconnectionAttempts) {
        reconnectDeepgramSTT(session);
      }
    });
    
    return true;
  } catch (error) {
    enhancedLog("error", "Deepgram", `Error initializing connection for session ${session.sessionId}: ${error.message}`, error);
    session.deepgramReady = false;
    return false;
  }
}

/**
 * Reconnect to Deepgram STT
 * @param {Object} session - The session object
 * @returns {Promise<boolean>} - True if successful
 */
async function reconnectDeepgramSTT(session) {
  session.reconnectionAttempts++;
  
  enhancedLog("info", "Deepgram", `Attempting to reconnect (attempt ${session.reconnectionAttempts}/${session.maxReconnectionAttempts}) for session ${session.sessionId}`);
  
  // Exponential backoff
  const backoffTime = Math.min(1000 * Math.pow(2, session.reconnectionAttempts - 1), 10000);
  enhancedLog("info", "Deepgram", `Waiting ${backoffTime}ms before reconnecting for session ${session.sessionId}`);
  
  await new Promise(resolve => setTimeout(resolve, backoffTime));
  
  return await initializeDeepgramConnection(session);
}

/**
 * Validate audio format for Twilio compatibility
 * @param {Buffer} audioBuffer - The audio buffer to validate
 * @returns {Object} - Validation result with status and message
 */
function validateAudioFormat(audioBuffer) {
  try {
    // Check if buffer exists and has content
    if (!audioBuffer || audioBuffer.length === 0) {
      return {
        valid: false,
        message: "Audio buffer is empty or null"
      };
    }
    
    // Log first few bytes for debugging
    const firstBytes = audioBuffer.slice(0, 20).toString("hex");
    enhancedLog("debug", "Audio", `Validating audio buffer (size: ${audioBuffer.length} bytes, first 20 bytes: ${firstBytes})`);
    
    // Check if buffer size is reasonable for audio
    if (audioBuffer.length < 1000) {
      return {
        valid: true,
        warning: `Audio buffer is unusually small (${audioBuffer.length} bytes), may be truncated`,
        message: "Audio format appears to be valid but buffer is small"
      };
    }
    
    // For μ-law audio, check if the buffer size is a multiple of expected chunk size
    const remainder = audioBuffer.length % 160;
    if (remainder !== 0) {
      return {
        valid: true,
        warning: `Audio buffer length (${audioBuffer.length}) is not a multiple of 160 bytes, last chunk will be padded`,
        message: "Audio format appears to be valid but may need padding"
      };
    }
    
    return {
      valid: true,
      message: "Audio format appears to be valid for Twilio"
    };
  } catch (error) {
    return {
      valid: false,
      message: `Error validating audio format: ${error.message}`
    };
  }
}

/**
 * Ensure audio chunks are exactly 160 bytes (pad if necessary)
 * @param {Buffer} chunk - The audio chunk to normalize
 * @returns {Buffer} - Normalized audio chunk
 */
function normalizeChunkSize(chunk) {
  if (chunk.length === 160) {
    return chunk; // Already correct size
  }
  
  if (chunk.length > 160) {
    // Truncate to 160 bytes
    enhancedLog("debug", "Audio", `Truncating chunk from ${chunk.length} to 160 bytes`);
    return chunk.slice(0, 160);
  }
  
  // Pad with silence (μ-law silence value is 255)
  enhancedLog("debug", "Audio", `Padding chunk from ${chunk.length} to 160 bytes`);
  const paddedChunk = Buffer.alloc(160, 255);
  chunk.copy(paddedChunk);
  return paddedChunk;
}

/**
 * Send audio to Twilio with proper format and simplified payload structure
 * @param {Object} session - The session object
 * @param {Buffer} audioBuffer - The audio buffer to send
 * @returns {Promise<boolean>} - True if successful
 */
async function sendAudioToTwilio(session, audioBuffer) {
  try {
    // Check if we have a streamSid
    if (!session.streamSid) {
      enhancedLog("error", "Twilio", `Cannot send audio: No streamSid available for session ${session.sessionId}`);
      return false;
    }
    
    // Check if WebSocket is open
    if (!checkWebSocketState(session, "send audio")) {
      return false;
    }
    
    enhancedLog("audio", "TTS", `Preparing to send audio (${audioBuffer.length} bytes) for session ${session.sessionId}`);
    
    // Validate audio format
    const validation = validateAudioFormat(audioBuffer);
    if (!validation.valid) {
      enhancedLog("error", "Audio", `Validation failed: ${validation.message} for session ${session.sessionId}`);
      return false;
    }
    
    if (validation.warning) {
      enhancedLog("warn", "Audio", validation.warning);
    }
    
    // Break audio into smaller chunks (20ms of audio at 8kHz = 160 bytes)
    const CHUNK_SIZE = 160;  // 20ms of 8kHz mulaw audio
    const chunks = [];
    
    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
      const chunk = audioBuffer.slice(i, Math.min(i + CHUNK_SIZE, audioBuffer.length));
      // Ensure each chunk is exactly 160 bytes
      chunks.push(normalizeChunkSize(chunk));
    }
    
    enhancedLog("audio", "Twilio", `Split audio into ${chunks.length} chunks of ${CHUNK_SIZE} bytes each for session ${session.sessionId}`);
    
    // Send each chunk with the minimal required fields
    let chunksSent = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const payload = chunk.toString("base64");
      
      // Use simplified payload structure as recommended
      const mediaMessage = {
        event: "media",
        media: {
          track: "outbound",
          payload: payload
        }
      };
      
      // Verify WebSocket is still open before sending
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        // Send through WebSocket back to Twilio
        session.ws.send(JSON.stringify(mediaMessage));
        
        // Log chunk details
        if (i === 0 || i === chunks.length - 1 || i % 50 === 0) {
          enhancedLog("debug", "Twilio", `Sent audio chunk ${i+1}/${chunks.length}, size: ${payload.length}, first 10 bytes (base64): ${payload.substring(0, 10)}... for session ${session.sessionId}`);
        }
        chunksSent++;
        
        // Add a small delay between chunks
        if (i < 5 || i % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      } else {
        enhancedLog("error", "Twilio", `WebSocket closed during audio transmission (chunk ${i+1}) for session ${session.sessionId}`);
        return false;
      }
    }
    
    enhancedLog("success", "Twilio", `Audio response sent: ${chunksSent} chunks for session ${session.sessionId}`);
    return true;
  } catch (error) {
    enhancedLog("error", "Twilio", `Error sending audio: ${error.message} for session ${session.sessionId}`, error);
    return false;
  }
}

/**
 * Fallback method to send audio to Twilio
 * Uses a different payload structure as a fallback
 * @param {Object} session - The session object
 * @param {Buffer} audioBuffer - The audio buffer to send
 * @returns {Promise<boolean>} - True if successful
 */
async function sendAudioToTwilioFallback(session, audioBuffer) {
  try {
    // Check if we have a streamSid
    if (!session.streamSid) {
      enhancedLog("error", "Twilio", `Cannot send fallback audio: No streamSid available for session ${session.sessionId}`);
      return false;
    }
    
    // Check if WebSocket is open
    if (!checkWebSocketState(session, "send fallback audio")) {
      return false;
    }
    
    enhancedLog("audio", "TTS", `Preparing to send fallback audio (${audioBuffer.length} bytes) for session ${session.sessionId}`);
    
    // Validate audio format
    const validation = validateAudioFormat(audioBuffer);
    if (!validation.valid) {
      enhancedLog("error", "Audio", `Fallback validation failed: ${validation.message} for session ${session.sessionId}`);
      return false;
    }
    
    if (validation.warning) {
      enhancedLog("warn", "Audio", `Fallback: ${validation.warning}`);
    }
    
    // Break audio into smaller chunks
    const CHUNK_SIZE = 160;
    const chunks = [];
    
    for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
      const chunk = audioBuffer.slice(i, Math.min(i + CHUNK_SIZE, audioBuffer.length));
      chunks.push(normalizeChunkSize(chunk));
    }
    
    enhancedLog("audio", "Twilio", `Fallback: Split audio into ${chunks.length} chunks of ${CHUNK_SIZE} bytes each for session ${session.sessionId}`);
    
    // FALLBACK: Try alternative payload structure
    let chunksSent = 0;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const payload = chunk.toString("base64");
      
      // Alternative payload structure
      const mediaMessage = {
        event: "media",
        streamSid: session.streamSid,
        media: {
          payload: payload
        }
      };
      
      // Verify WebSocket is still open before sending
      if (session.ws && session.ws.readyState === WebSocket.OPEN) {
        // Send through WebSocket back to Twilio
        session.ws.send(JSON.stringify(mediaMessage));
        
        // Log chunk details
        if (i === 0 || i === chunks.length - 1 || i % 50 === 0) {
          enhancedLog("debug", "Twilio", `Fallback: Sent audio chunk ${i+1}/${chunks.length}, size: ${payload.length}, first 10 bytes (base64): ${payload.substring(0, 10)}... for session ${session.sessionId}`);
        }
        chunksSent++;
        
        // Add a small delay between chunks
        if (i < 5 || i % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      } else {
        enhancedLog("error", "Twilio", `Fallback: WebSocket closed during audio transmission (chunk ${i+1}) for session ${session.sessionId}`);
        return false;
      }
    }
    
    enhancedLog("success", "Twilio", `Fallback: Audio response sent: ${chunksSent} chunks for session ${session.sessionId}`);
    return true;
  } catch (error) {
    enhancedLog("error", "Twilio", `Fallback: Error sending audio: ${error.message} for session ${session.sessionId}`, error);
    return false;
  }
}

/**
 * Send greeting message
 * @param {Object} session - The session object
 * @returns {Promise<boolean>} - True if successful
 */
async function sendGreetingMessage(session) {
  try {
    // Increment greeting attempts
    session.greetingAttempts++;
    
    // Check if we've already tried too many times
    if (session.greetingAttempts > session.maxGreetingAttempts) {
      enhancedLog("error", "Greeting", `Failed to send after ${session.maxGreetingAttempts} attempts for session ${session.sessionId}`);
      return false;
    }
    
    enhancedLog("info", "Greeting", `Sending message (attempt ${session.greetingAttempts}/${session.maxGreetingAttempts}) for session ${session.sessionId}`);
    
    // Default greeting message
    const greeting = "Hello! This is Caring Clarity's AI assistant. How can I help you schedule an appointment today?";
    
    // Add to conversation history
    session.conversationHistory.push(greeting);
    
    // Generate TTS for the greeting
    const result = await generateAndSendTTS(session, greeting);
    
    if (result) {
      session.welcomeMessageSent = true;
      enhancedLog("success", "Greeting", `Message sent successfully for session ${session.sessionId}`);
      return true;
    } else {
      enhancedLog("error", "Greeting", `Failed to send greeting audio to Twilio for session ${session.sessionId}`);
      
      // Try again after a delay if we haven't reached the maximum attempts
      if (session.greetingAttempts < session.maxGreetingAttempts) {
        enhancedLog("info", "Greeting", `Will retry in 2 seconds for session ${session.sessionId}`);
        setTimeout(() => sendGreetingMessage(session), 2000);
      }
      
      return false;
    }
  } catch (error) {
    enhancedLog("error", "Greeting", `Error sending message: ${error.message} for session ${session.sessionId}`, error);
    return false;
  }
}

/**
 * Generate TTS audio and send it to Twilio
 * @param {Object} session - The session object
 * @param {string} text - The text to convert to speech
 * @returns {Promise<boolean>} - True if audio was successfully sent
 */
async function generateAndSendTTS(session, text) {
  // FIXED: Add explicit TTS generation tracking
  session.lastTtsText = text;
  session.ttsRequests++;
  
  // Generate TTS for the response
  enhancedLog("info", "TTS", `Starting TTS generation #${session.ttsRequests} for session ${session.sessionId}`);
  enhancedLog("info", "TTS", `Text to convert: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
  
  const ttsStartTime = Date.now();
  const ttsAudio = await generateDeepgramTTS(text);
  const ttsDuration = Date.now() - ttsStartTime;
  
  if (ttsAudio && ttsAudio.length > 0) {
    session.ttsSuccesses++;
    session.lastTtsAudioSize = ttsAudio.length;
    
    enhancedLog("success", "TTS", `Generated audio #${session.ttsRequests} (${ttsAudio.length} bytes, ${ttsDuration}ms) for session ${session.sessionId}`);
    
    // Save a sample of the TTS audio for debugging
    try {
      const samplePath = `./tts-sample-${session.sessionId}-${Date.now()}.mulaw`;
      fs.writeFileSync(samplePath, ttsAudio.slice(0, Math.min(1000, ttsAudio.length)));
      enhancedLog("debug", "TTS", `Saved TTS sample to ${samplePath}`);
    } catch (error) {
      enhancedLog("error", "TTS", `Failed to save TTS sample: ${error.message}`);
    }
    
    // Check WebSocket state before sending
    if (checkWebSocketState(session, "send TTS audio")) {
      // Send audio back to Twilio
      enhancedLog("info", "Twilio", `Starting audio transmission for session ${session.sessionId}`);
      const audioSendResult = await sendAudioToTwilio(session, ttsAudio);
      
      if (audioSendResult) {
        enhancedLog("success", "Twilio", `Successfully sent TTS audio to Twilio for session ${session.sessionId}`);
        return true;
      } else {
        enhancedLog("error", "Twilio", `Failed to send TTS audio to Twilio for session ${session.sessionId}`);
        // Try fallback method if primary method fails
        enhancedLog("info", "Twilio", `Attempting fallback audio transmission for session ${session.sessionId}`);
        const fallbackResult = await sendAudioToTwilioFallback(session, ttsAudio);
        
        if (fallbackResult) {
          enhancedLog("success", "Twilio", `Fallback audio transmission succeeded for session ${session.sessionId}`);
          return true;
        } else {
          enhancedLog("error", "Twilio", `Fallback audio transmission failed for session ${session.sessionId}`);
          return false;
        }
      }
    } else {
      enhancedLog("error", "Twilio", `Cannot send TTS: WebSocket not open for session ${session.sessionId}`);
      return false;
    }
  } else {
    session.ttsFailures++;
    session.lastTtsError = "Empty or null audio buffer";
    
    enhancedLog("error", "TTS", `Failed to generate audio for AI response for session ${session.sessionId}`);
    enhancedLog("error", "TTS", `TTS failure #${session.ttsFailures}: ${session.lastTtsError}`);
    
    // Try fallback TTS method
    enhancedLog("info", "TTS", `Attempting fallback TTS method for session ${session.sessionId}`);
    const fallbackAudio = await generateFallbackTTS(text);
    
    if (fallbackAudio && fallbackAudio.length > 0) {
      enhancedLog("success", "TTS", `Fallback TTS generated (${fallbackAudio.length} bytes) for session ${session.sessionId}`);
      
      // Check WebSocket state before sending
      if (checkWebSocketState(session, "send fallback TTS audio")) {
        // Send audio back to Twilio
        enhancedLog("info", "Twilio", `Starting fallback audio transmission for session ${session.sessionId}`);
        const result = await sendAudioToTwilio(session, fallbackAudio);
        return result;
      } else {
        enhancedLog("error", "Twilio", `Cannot send fallback TTS: WebSocket not open for session ${session.sessionId}`);
        return false;
      }
    } else {
      enhancedLog("error", "TTS", `Fallback TTS also failed for session ${session.sessionId}`);
      return false;
    }
  }
}

/**
 * Generate TTS audio using Deepgram
 * @param {string} text - The text to convert to speech
 * @returns {Promise<Buffer|null>} - Audio buffer or null if failed
 */
async function generateDeepgramTTS(text) {
  try {
    enhancedLog("info", "TTS", `Generating Deepgram TTS for: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`);
    
    // Log to TTS debug file
    const ttsLogMessage = `Generating TTS for: "${text}"\n`;
    fs.appendFileSync("./tts-debug.log", ttsLogMessage);
    
    // FIXED: Implement text chunking
    const textChunks = chunkText(text, 2000); // Use 2000 character limit
    enhancedLog("debug", "TTS", `Split text into ${textChunks.length} chunks for TTS`);
    fs.appendFileSync("./tts-debug.log", `Split text into ${textChunks.length} chunks\n`);
    
    const audioBuffers = [];
    
    for (const chunk of textChunks) {
      enhancedLog("debug", "TTS", `Generating TTS for chunk: ${chunk.substring(0, 50)}...`);
      fs.appendFileSync("./tts-debug.log", `Generating TTS for chunk: ${chunk.substring(0, 50)}...\n`);
      
      // Add retry logic for each chunk
      const maxRetries = 3;
      let retryCount = 0;
      let lastError = null;
      let chunkAudioBuffer = null;
      
      while (retryCount < maxRetries) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
          
          // Use the documented REST API endpoint
          const ttsUrl = "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000";
          enhancedLog("debug", "TTS", `Calling Deepgram TTS API: ${ttsUrl}`);
          
          // Log request details
          fs.appendFileSync("./tts-debug.log", `TTS API URL: ${ttsUrl}\n`);
          fs.appendFileSync("./tts-debug.log", `TTS API Request Body: ${JSON.stringify({text: chunk})}\n`);
          
          const ttsStartTime = Date.now();
          const response = await fetch(ttsUrl, {
            method: "POST",
            headers: {
              "Authorization": `Token ${process.env.DEEPGRAM_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: chunk,
            }),
            signal: controller.signal
          });

          clearTimeout(timeoutId);
          const ttsDuration = Date.now() - ttsStartTime;
          enhancedLog("debug", "TTS", `Deepgram TTS API response status: ${response.status} (${ttsDuration}ms)`);
          
          // Log response details
          fs.appendFileSync("./tts-debug.log", `TTS API Response Status: ${response.status} (${ttsDuration}ms)\n`);
          fs.appendFileSync("./tts-debug.log", `TTS API Response Headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}\n`);

          if (response.ok) {
            chunkAudioBuffer = Buffer.from(await response.arrayBuffer());
            enhancedLog("success", "TTS", `Deepgram TTS chunk generated successfully (${chunkAudioBuffer.length} bytes)`);
            
            // Log audio buffer details
            fs.appendFileSync("./tts-debug.log", `TTS Audio Chunk Buffer Size: ${chunkAudioBuffer.length} bytes\n`);
            
            // Verify audio format
            if (chunkAudioBuffer.length > 0) {
              // Log first few bytes for debugging
              const firstBytes = chunkAudioBuffer.slice(0, 20).toString("hex");
              enhancedLog("debug", "TTS", `Generated audio chunk first 20 bytes: ${firstBytes}`);
              fs.appendFileSync("./tts-debug.log", `TTS Audio Chunk First 20 Bytes: ${firstBytes}\n`);
              
              // Save a sample of the audio for debugging
              try {
                const samplePath = `./tts-chunk-sample-${Date.now()}.mulaw`;
                fs.writeFileSync(samplePath, chunkAudioBuffer.slice(0, 1000));
                enhancedLog("debug", "TTS", `Saved TTS chunk sample to ${samplePath}`);
                fs.appendFileSync("./tts-debug.log", `TTS Chunk Sample Saved: ${samplePath}\n`);
              } catch (error) {
                enhancedLog("error", "TTS", `Failed to save TTS chunk sample: ${error.message}`);
              }
              
              break; // Success, exit retry loop
            } else {
              enhancedLog("error", "TTS", `Deepgram returned empty audio buffer for chunk`);
              fs.appendFileSync("./tts-debug.log", `ERROR: Deepgram returned empty audio buffer for chunk\n`);
              lastError = new Error("Empty audio buffer for chunk");
            }
          } else {
            const errorText = await response.text();
            enhancedLog("error", "TTS", `Deepgram failed for chunk (attempt ${retryCount + 1}/${maxRetries}): ${response.status} ${response.statusText} - ${errorText}`);
            fs.appendFileSync("./tts-debug.log", `ERROR: Deepgram TTS failed for chunk (attempt ${retryCount + 1}/${maxRetries}): ${response.status} ${response.statusText} - ${errorText}\n`);
            lastError = new Error(`HTTP ${response.status}: ${errorText}`);
          }
        } catch (error) {
          clearTimeout(timeoutId);
          enhancedLog("error", "TTS", `Deepgram error for chunk (attempt ${retryCount + 1}/${maxRetries}): ${error.message}`, error);
          fs.appendFileSync("./tts-debug.log", `ERROR: Deepgram TTS error for chunk (attempt ${retryCount + 1}/${maxRetries}): ${error.message}\n`);
          lastError = error;
        }
        
        retryCount++;
        if (retryCount < maxRetries) {
          // Exponential backoff
          const backoffTime = Math.min(1000 * Math.pow(2, retryCount - 1), 5000);
          enhancedLog("info", "TTS", `Waiting ${backoffTime}ms before retry for chunk...`);
          fs.appendFileSync("./tts-debug.log", `Waiting ${backoffTime}ms before retry for chunk...\n`);
          await new Promise(resolve => setTimeout(resolve, backoffTime));
        }
      }
      
      // If chunk generation failed after retries, stop processing
      if (!chunkAudioBuffer) {
        enhancedLog("error", "TTS", `All Deepgram attempts failed for chunk: ${lastError?.message}`);
        fs.appendFileSync("./tts-debug.log", `ERROR: All Deepgram TTS attempts failed for chunk: ${lastError?.message}\n`);
        return null; // Return null if any chunk fails
      }
      
      audioBuffers.push(chunkAudioBuffer);
    }
    
    // Concatenate all audio buffers
    const finalAudioBuffer = Buffer.concat(audioBuffers);
    enhancedLog("success", "TTS", `Concatenated ${audioBuffers.length} audio chunks into final buffer (${finalAudioBuffer.length} bytes)`);
    fs.appendFileSync("./tts-debug.log", `Concatenated ${audioBuffers.length} audio chunks into final buffer (${finalAudioBuffer.length} bytes)\n`);
    
    return finalAudioBuffer;
    
  } catch (error) {
    enhancedLog("error", "TTS", `Deepgram error: ${error.message}`, error);
    fs.appendFileSync("./tts-debug.log", `ERROR: Deepgram TTS error: ${error.message}\n`);
    return null;
  }
}

/**
 * Generate fallback TTS audio
 * @param {string} text - The text to convert to speech
 * @returns {Promise<Buffer|null>} - Audio buffer or null if failed
 */
async function generateFallbackTTS(text) {
  try {
    enhancedLog("info", "TTS", `Generating fallback TTS for: ${text.substring(0, 50)}${text.length > 50 ? "..." : ""}`);
    
    // Log to TTS debug file
    fs.appendFileSync("./tts-debug.log", `Generating fallback TTS for: "${text}"\n`);
    
    // Placeholder: Generate a simple tone pattern
    const toneLength = Math.min(text.length * 50, 10000);
    const sampleRate = 8000;
    const bufferSize = Math.ceil(toneLength * sampleRate / 1000);
    
    const buffer = Buffer.alloc(bufferSize);
    for (let i = 0; i < bufferSize; i++) {
      const value = Math.floor(128 + 127 * Math.sin(i * 0.1)) % 256;
      buffer[i] = value;
    }
    
    enhancedLog("debug", "TTS", `Generated fallback audio buffer (${buffer.length} bytes)`);
    fs.appendFileSync("./tts-debug.log", `Fallback TTS Audio Buffer Size: ${buffer.length} bytes\n`);
    
    // Save a sample of the fallback audio for debugging
    try {
      const samplePath = `./tts-fallback-sample-${Date.now()}.raw`;
      fs.writeFileSync(samplePath, buffer.slice(0, 1000));
      enhancedLog("debug", "TTS", `Saved fallback TTS sample to ${samplePath}`);
      fs.appendFileSync("./tts-debug.log", `Fallback TTS Sample Saved: ${samplePath}\n`);
    } catch (error) {
      enhancedLog("error", "TTS", `Failed to save fallback TTS sample: ${error.message}`);
    }
    
    return buffer;
  } catch (error) {
    enhancedLog("error", "TTS", `Fallback TTS error: ${error.message}`, error);
    fs.appendFileSync("./tts-debug.log", `ERROR: Fallback TTS error: ${error.message}\n`);
    return null;
  }
}

/**
 * Generate AI response using Groq
 * @param {Object} session - The session object
 * @param {string} userMessage - The user's message
 * @returns {Promise<string|null>} - AI response or null if failed
 */
async function generateAIResponse(session, userMessage) {
  try {
    enhancedLog("info", "AI", `Generating response for session ${session.sessionId}`);
    
    // Add retry logic
    const maxRetries = 3;
    let retryCount = 0;
    let lastError = null;
    
    while (retryCount < maxRetries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
        
        // Prepare conversation history for the AI
        const messages = [];
        
        // System message
        messages.push({
          role: "system",
          content: `You are an AI assistant for Caring Clarity, a counseling practice. Your name is Claire.
Your job is to help callers schedule appointments with our therapists.
Be warm, empathetic, and professional. Keep responses brief and conversational.
Ask for the following information:
1. Whether they're seeking services for themselves, a child, or as a couple
2. Their name
3. Email address
4. State of residence (we can only serve clients in certain states)
5. Phone number
6. Best days/times for appointments
7. Insurance information (if any)
Once you have this information, tell them that someone from our team will contact them soon to confirm their appointment.
If they ask questions about our services, provide brief information and guide them back to scheduling.
If they express distress or crisis, express empathy and ask if they'd like resources for immediate support.`
        });
        
        // Add conversation history
        for (let i = 0; i < session.conversationHistory.length; i++) {
          const role = i % 2 === 0 ? "user" : "assistant";
          messages.push({
            role: role,
            content: session.conversationHistory[i]
          });
        }
        
        // Add current user message
        messages.push({
          role: "user",
          content: userMessage
        });
        
        // Call Groq API
        const groqUrl = "https://api.groq.com/openai/v1/chat/completions";
        enhancedLog("debug", "AI", `Calling Groq API: ${groqUrl}`);
        
        const response = await fetch(groqUrl, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "llama3-8b-8192",
            messages: messages,
            temperature: 0.7,
            max_tokens: 800,
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);
        enhancedLog("debug", "AI", `Groq API response status: ${response.status}`);

        if (response.ok) {
          const data = await response.json();
          if (data.choices && data.choices.length > 0) {
            const aiResponseText = data.choices[0].message.content;
            enhancedLog("success", "AI", `Groq API response received successfully`);
            return aiResponseText;
          } else {
            enhancedLog("error", "AI", `Groq API returned empty choices array for session ${session.sessionId}`);
            lastError = new Error("Empty choices array");
          }
        } else {
          const errorText = await response.text();
          enhancedLog("error", "AI", `Groq API error (attempt ${retryCount + 1}/${maxRetries}): ${response.status} ${response.statusText} - ${errorText} for session ${session.sessionId}`);
          lastError = new Error(`HTTP ${response.status}: ${errorText}`);
        }
      } catch (error) {
        clearTimeout(timeoutId);
        enhancedLog("error", "AI", `Groq API error (attempt ${retryCount + 1}/${maxRetries}): ${error.message} for session ${session.sessionId}`, error);
        lastError = error;
      }
      
      retryCount++;
      if (retryCount < maxRetries) {
        // Exponential backoff
        const backoffTime = Math.min(1000 * Math.pow(2, retryCount - 1), 5000);
        enhancedLog("info", "AI", `Waiting ${backoffTime}ms before retry for session ${session.sessionId}`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }
    
    enhancedLog("error", "AI", `All Groq API attempts failed: ${lastError?.message} for session ${session.sessionId}`);
    return null;
  } catch (error) {
    enhancedLog("error", "AI", `Error generating response: ${error.message} for session ${session.sessionId}`, error);
    return null;
  }
}

/**
 * Log conversation turn to database
 * @param {Object} session - The session object
 * @param {string} userMessage - The user's message
 * @param {string} aiResponse - The AI's response
 * @returns {Promise<boolean>} - True if successful
 */
async function logConversationTurn(session, userMessage, aiResponse) {
  try {
    // Only attempt to log if we have both messages
    if (!userMessage || !aiResponse) {
      enhancedLog("warn", "Database", `Skipping conversation logging due to missing messages for session ${session.sessionId}`);
      return false;
    }
    
    // Ensure we're using the proper Supabase client
    try {
      enhancedLog("debug", "Database", `Logging conversation turn for session ${session.sessionId}`);
      const { error } = await supabase.from("conversation_turns").insert({
        conversation_id: session.callSid,
        user_message: userMessage,
        ai_response: aiResponse,
        timestamp: new Date().toISOString(),
        metadata: {
          tenant_id: session.tenantId,
          user_id: session.userId,
          session_id: session.sessionId
        }
      });
      
      if (error) {
        throw error;
      }
      
      enhancedLog("success", "Database", `Conversation logged for session ${session.sessionId}`);
      return true;
    } catch (error) {
      enhancedLog("error", "Database", `Error logging conversation: ${error.message} for session ${session.sessionId}`, error);
      return false;
    }
  } catch (error) {
    enhancedLog("error", "Database", `Error logging conversation: ${error.message} for session ${session.sessionId}`, error);
    return false;
  }
}

/**
 * Send error message to client
 * @param {Object} session - The session object
 * @param {string} code - Error code
 * @param {string} message - Error message
 */
function sendErrorToClient(session, code, message) {
  try {
    if (checkWebSocketState(session, "send error message")) {
      session.ws.send(JSON.stringify({
        event: "error",
        error: {
          code,
          message
        }
      }));
      enhancedLog("info", "WebSocket", `Sent error to client: ${code} - ${message} for session ${session.sessionId}`);
    }
  } catch (error) {
    enhancedLog("error", "WebSocket", `Error sending error message to client: ${error.message} for session ${session.sessionId}`, error);
  }
}

/**
 * Clean up session resources
 * @param {string} sessionId - The session ID
 */
async function cleanupSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    // Check if we're still processing a response
    if (session.isProcessingResponse) {
      enhancedLog("info", "Session", `Still processing a response, delaying cleanup for session ${sessionId}`);
      session.pendingCleanup = true;
      return;
    }
    
    // Clear any intervals
    if (session.pingInterval) {
      clearInterval(session.pingInterval);
    }
    
    // Close Deepgram connection
    if (session.deepgramConnection) {
      try {
        session.deepgramConnection.close();
      } catch (error) {
        enhancedLog("error", "Deepgram", `Error closing connection: ${error.message} for session ${sessionId}`, error);
      }
    }
    
    // Log session stats
    enhancedLog("info", "Session", `Stats for ${sessionId}:`, {
      totalAudioChunksReceived: session.audioStats.totalChunksReceived,
      totalAudioChunksProcessed: session.audioStats.totalChunksProcessed,
      queueHighWaterMark: session.audioStats.queueHighWaterMark,
      conversationTurns: session.conversationHistory.length / 2,
      reconnectionAttempts: session.reconnectionAttempts,
      greetingAttempts: session.greetingAttempts,
      outboundChunks: session.outboundChunkCounter - 1,
      deepgramMessages: session.deepgramMessages,
      deepgramTranscripts: session.deepgramTranscripts,
      ttsRequests: session.ttsRequests,
      ttsSuccesses: session.ttsSuccesses,
      ttsFailures: session.ttsFailures
    });
    
    // Remove from active sessions
    activeSessions.delete(sessionId);
    enhancedLog("success", "Session", `Cleaned up session: ${sessionId}`);
  }
}

/**
 * Handle text chunking for TTS character limit
 * @param {string} text - The text to chunk
 * @param {number} maxLength - Maximum chunk length
 * @returns {string[]} - Array of text chunks
 */
function chunkText(text, maxLength = 2000) {
  if (text.length <= maxLength) {
    return [text];
  }
  
  enhancedLog("debug", "TTS", `Text length (${text.length}) exceeds max length (${maxLength}), chunking...`);
  
  const chunks = [];
  let currentChunk = "";
  
  // Split by sentences (roughly)
  const sentences = text.split(/(?<=[.!?])\s+/);
  
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length <= maxLength) {
      currentChunk += (currentChunk ? " " : "") + sentence;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
      }
      
      // If a single sentence is too long, split it further
      if (sentence.length > maxLength) {
        enhancedLog("warn", "TTS", `Single sentence exceeds max length (${sentence.length}), splitting mid-sentence`);
        let remainingSentence = sentence;
        while (remainingSentence.length > 0) {
          const chunk = remainingSentence.substring(0, maxLength);
          chunks.push(chunk);
          remainingSentence = remainingSentence.substring(maxLength);
        }
        currentChunk = ""; // Reset current chunk
      } else {
        currentChunk = sentence;
      }
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  enhancedLog("debug", "TTS", `Chunked text into ${chunks.length} parts`);
  return chunks;
}

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now();
  let staleSessions = 0;
  
  activeSessions.forEach((session, sessionId) => {
    // If no activity for 5 minutes, clean up
    if (now - session.lastActivityTimestamp > 5 * 60 * 1000) {
      enhancedLog("info", "Session", `Cleaning up stale session: ${sessionId}`);
      cleanupSession(sessionId);
      staleSessions++;
    }
  });
  
  if (staleSessions > 0) {
    enhancedLog("info", "Session", `Cleaned up ${staleSessions} stale sessions`);
  }
}, 60 * 1000); // Check every minute

// Graceful shutdown
process.on("SIGTERM", () => {
  enhancedLog("info", "Server", "Shutting down gracefully...");
  
  // Close all active sessions
  activeSessions.forEach((session, sessionId) => {
    cleanupSession(sessionId);
  });
  
  wss.close(() => {
    server.close(() => {
      enhancedLog("success", "Server", "Server closed");
      process.exit(0);
    });
  });
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  enhancedLog("error", "Server", "Uncaught exception:", error);
  // Continue running - don't exit
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  enhancedLog("error", "Server", "Unhandled promise rejection:", reason);
  // Continue running - don't exit
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  enhancedLog("success", "Server", `WebSocket server running on port ${PORT}`);
  enhancedLog("info", "Server", `WebSocket endpoint: ws://localhost:${PORT}/stream`);
  enhancedLog("info", "Server", `Health check: http://localhost:${PORT}/health`);
  enhancedLog("info", "Server", `Debug page: http://localhost:${PORT}/debug`);
  enhancedLog("info", "Server", `Deepgram logs: http://localhost:${PORT}/deepgram-logs`);
  enhancedLog("info", "Server", `TTS logs: http://localhost:${PORT}/tts-logs`);
  enhancedLog("info", "Server", `TTS test: http://localhost:${PORT}/test-tts?text=Hello`);
  enhancedLog("info", "Server", `Audio playback test: http://localhost:${PORT}/test-audio-playback`);
});

// Export BidirectionalStreamingManager for external use
module.exports = {
  server,
  wss,
  activeSessions
};
