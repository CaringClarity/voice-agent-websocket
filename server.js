/**
 * Enhanced WebSocket Server for Twilio Voice Assistant
 * With Deepgram TTS for greeting and responses
 */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');

// Load environment variables from .env file if present
dotenv.config();

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Check required environment variables
const requiredEnvVars = [
  'DEEPGRAM_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY', 
  'GROQ_API_KEY'
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
  console.error(`❌ Cannot start server due to missing environment variables: ${missingEnvVars.join(', ')}`);
  console.error('Please set these variables in your environment or .env file and try again.');
  process.exit(1);
}

console.log('✅ Environment variables checked');

// Initialize Supabase client
// FIXED: Ensure we're using the REST API URL, not a PostgreSQL connection string
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Validate Supabase URL format
if (supabaseUrl && supabaseUrl.includes('@')) {
  console.error('❌ Invalid Supabase URL format. The URL should not contain credentials.');
  console.error('Please use the REST API URL from your Supabase dashboard (e.g., https://your-project-id.supabase.co)');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

// Create WebSocket server with explicit path for Twilio streams
const wss = new WebSocket.Server({ 
  server,
  path: '/stream'
});

// Store active sessions
const activeSessions = new Map();

// Configure Express middleware
app.use(express.json());
app.use(express.static('public'));

// Health check endpoint
app.get('/health', (req, res) => {
  const activeSessionCount = activeSessions.size;
  
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    activeConnections: activeSessionCount
  });
});

// Debug endpoint for WebSocket testing
app.get('/debug', (req, res) => {
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
        const statusEl = document.getElementById('status');
        const logEl = document.getElementById('log');
        const reconnectBtn = document.getElementById('reconnect');
        const sendTestAudioBtn = document.getElementById('sendTestAudio');
        const clearLogBtn = document.getElementById('clearLog');
        const audioStatusEl = document.getElementById('audioStatus');
        
        let ws;
        let sessionId;
        let callSid;
        
        function log(message) {
          const timestamp = new Date().toISOString();
          logEl.textContent = \`[\${timestamp}] \${message}\\n\` + logEl.textContent;
        }
        
        function connect() {
          statusEl.textContent = 'Connecting...';
          statusEl.className = 'connecting';
          
          // Create a test session ID
          sessionId = 'session-test-' + Date.now();
          callSid = 'test-call-' + Date.now();
          
          // Connect to the WebSocket server
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const wsUrl = \`\${protocol}//\${window.location.host}/stream?callSid=\${callSid}&sessionId=\${sessionId}&tenantId=test&userId=test&sendGreeting=true\`;
          log(\`Connecting to \${wsUrl}\`);
          
          ws = new WebSocket(wsUrl);
          
          ws.onopen = () => {
            statusEl.textContent = 'Connected!';
            statusEl.className = 'connected';
            log('Connection established');
            
            // Send a test start event
            const startEvent = {
              event: 'start',
              start: {
                callSid: callSid,
                streamSid: 'test-stream-' + Date.now()
              }
            };
            
            ws.send(JSON.stringify(startEvent));
            log('Sent start event: ' + JSON.stringify(startEvent));
          };
          
          ws.onclose = (event) => {
            statusEl.textContent = \`Disconnected (code: \${event.code})\`;
            statusEl.className = 'disconnected';
            log(\`Connection closed: code=\${event.code}, reason=\${event.reason}\`);
          };
          
          ws.onerror = (error) => {
            statusEl.textContent = 'Error';
            statusEl.className = 'disconnected';
            log('Connection error');
          };
          
          ws.onmessage = (event) => {
            try {
              // Try to parse as JSON
              const data = JSON.parse(event.data);
              log('Received: ' + JSON.stringify(data, null, 2));
            } catch (e) {
              // If not JSON, might be binary
              log('Received binary data of length: ' + event.data.length);
            }
          };
        }
        
        function sendTestAudio() {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            log('Cannot send test audio: WebSocket not connected');
            return;
          }
          
          // Create a simple media event with dummy audio data
          const mediaEvent = {
            event: 'media',
            media: {
              track: 'inbound',
              chunk: 1,
              timestamp: Date.now(),
              payload: btoa('test audio data').repeat(10) // Base64 dummy data
            }
          };
          
          ws.send(JSON.stringify(mediaEvent));
          log('Sent test audio data');
          audioStatusEl.textContent = 'Test audio sent at ' + new Date().toLocaleTimeString();
        }
        
        reconnectBtn.addEventListener('click', () => {
          if (ws) {
            ws.close();
          }
          connect();
        });
        
        sendTestAudioBtn.addEventListener('click', sendTestAudio);
        
        clearLogBtn.addEventListener('click', () => {
          logEl.textContent = '';
          log('Log cleared');
        });
        
        // Initial connection
        connect();
      </script>
    </body>
    </html>
  `);
});

// Groq model list endpoint for debugging
app.get('/groq-models', async (req, res) => {
  try {
    const response = await fetch('https://api.groq.com/openai/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({
        error: `Groq API error: ${response.status} ${response.statusText}`,
        details: errorText
      });
    }
    
    const models = await response.json();
    res.json(models);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to fetch Groq models',
      message: error.message
    });
  }
});

// WebSocket connection handler
wss.on('connection', async (ws, req) => {
  // Parse URL parameters
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callSid = url.searchParams.get('callSid');
  const sessionId = url.searchParams.get('sessionId') || `session-${callSid}-${Date.now()}`;
  const tenantId = url.searchParams.get('tenantId');
  const userId = url.searchParams.get('userId');
  const sendGreeting = url.searchParams.get('sendGreeting') === 'true';

  console.log(`📞 New WebSocket connection: ${callSid}`);
  console.log(`URL parameters: callSid=${callSid}, sessionId=${sessionId}, tenantId=${tenantId}, userId=${userId}, sendGreeting=${sendGreeting}`);

  // Initialize session
  const session = {
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
    outboundChunkCounter: 1
  };

  activeSessions.set(sessionId, session);

  // Set up ping interval to keep connection alive
  session.pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      const now = Date.now();
      // Only send ping if we haven't received anything in the last 10 seconds
      if (now - session.lastActivityTimestamp > 10000) {
        try {
          ws.ping();
          session.lastPingTimestamp = now;
        } catch (error) {
          console.error(`❌ Error sending ping to client: ${error.message}`);
        }
      }
    } else {
      // Clear interval if connection is closed
      clearInterval(session.pingInterval);
    }
  }, 15000);

  // Initialize Deepgram immediately
  console.log("🚀 Initializing Deepgram immediately on connection");
  const deepgramInitialized = await initializeDeepgramConnection(session);
  
  if (!deepgramInitialized) {
    console.error(`❌ Failed to initialize Deepgram for session ${sessionId}`);
    // Send error message to client
    try {
      ws.send(JSON.stringify({
        event: 'error',
        error: {
          message: 'Failed to initialize speech recognition service',
          code: 'DEEPGRAM_INIT_FAILED'
        }
      }));
    } catch (error) {
      console.error(`❌ Error sending error message to client: ${error.message}`);
    }
  }

  ws.on('message', async (message) => {
    try {
      // Update activity timestamp
      session.lastActivityTimestamp = Date.now();
      
      console.log(`📥 Received raw message of length: ${message.length} bytes`);
      
      // Try to parse as JSON
      try {
        const data = JSON.parse(message);
        console.log(`📨 Received event: ${data.event}`);
        
        // Store streamSid if this is a start event
        if (data.event === 'start' && data.start && data.start.streamSid) {
          session.streamSid = data.start.streamSid;
          console.log(`🎙️ Stream started with SID: ${session.streamSid}`);
          
          // Send greeting if needed and we have the streamSid
          if (!session.welcomeMessageSent && session.streamSid) {
            await sendGreetingMessage(session);
          }
        }
        
        // Handle media event
        if (data.event === 'media' && data.media && data.media.payload && data.media.track === 'inbound') {
          // Convert from base64
          const audioBuffer = Buffer.from(data.media.payload, 'base64');
          session.audioStats.totalChunksReceived++;
          
          // Check if Deepgram is ready
          if (session.deepgramReady && session.deepgramConnection && 
              session.deepgramConnection.readyState === WebSocket.OPEN) {
            session.deepgramConnection.send(audioBuffer);
            session.audioStats.totalChunksProcessed++;
            console.log('🎤 Forwarded audio to Deepgram');
          } else {
            // Queue audio until Deepgram is ready
            if (session.audioQueue.length < 500) {
              session.audioQueue.push(audioBuffer);
              // Update high water mark
              if (session.audioQueue.length > session.audioStats.queueHighWaterMark) {
                session.audioStats.queueHighWaterMark = session.audioQueue.length;
              }
              console.log(`📦 Queued audio chunk (queue size: ${session.audioQueue.length})`);
            } else {
              console.warn(`⚠️ Audio queue full, dropping chunk (queue size: ${session.audioQueue.length})`);
              // If queue is full and Deepgram is not ready, try to reconnect
              if (!session.deepgramReady && session.reconnectionAttempts < session.maxReconnectionAttempts) {
                await reconnectDeepgramSTT(session);
              }
            }
          }
        }
        
        // Handle stop event
        if (data.event === 'stop') {
          console.log('🛑 Stream stopped');
          await cleanupSession(session.sessionId);
        }
      } catch (jsonError) {
        // Not JSON, might be binary audio data
        console.log(`📦 Received binary data, length: ${message.length} bytes`);
        session.audioStats.totalChunksReceived++;
        
        // If Deepgram is ready, forward the audio
        if (session.deepgramReady && session.deepgramConnection && 
            session.deepgramConnection.readyState === WebSocket.OPEN) {
          session.deepgramConnection.send(message);
          session.audioStats.totalChunksProcessed++;
          console.log('🎤 Forwarded binary audio to Deepgram');
        } else {
          // Queue audio until Deepgram is ready
          if (session.audioQueue.length < 500) {
            session.audioQueue.push(message);
            // Update high water mark
            if (session.audioQueue.length > session.audioStats.queueHighWaterMark) {
              session.audioStats.queueHighWaterMark = session.audioQueue.length;
            }
            console.log(`📦 Queued binary audio chunk (queue size: ${session.audioQueue.length})`);
          } else {
            console.warn(`⚠️ Audio queue full, dropping chunk (queue size: ${session.audioQueue.length})`);
          }
        }
      }
    } catch (error) {
      console.error('❌ WebSocket message error:', error);
    }
  });

  // Handle pong responses to track connection health
  ws.on('pong', () => {
    const latency = Date.now() - session.lastPingTimestamp;
    console.log(`📡 Received pong from client, latency: ${latency}ms`);
    session.lastActivityTimestamp = Date.now();
  });

  ws.on('close', (code, reason) => {
    console.log(`📞 WebSocket closed: ${sessionId}, code: ${code}, reason: ${reason || 'No reason provided'}`);
    clearInterval(session.pingInterval);
    cleanupSession(sessionId);
  });
});

/**
 * Initialize Deepgram STT connection
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
        console.error('❌ Error closing existing Deepgram connection:', error);
      }
    }
    
    // Create a new WebSocket connection to Deepgram
    const deepgramUrl = 'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&model=nova-2&smart_format=true&filler_words=false&interim_results=false&endpointing=500';
    
    session.deepgramConnection = new WebSocket(deepgramUrl, {
      headers: {
        Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`
      }
    });
    
    // Set up event handlers
    session.deepgramConnection.on('open', () => {
      console.log('🎙️ Deepgram connection established');
      session.deepgramReady = true;
      
      // Process any queued audio
      if (session.audioQueue.length > 0) {
        console.log(`📤 Processing ${session.audioQueue.length} queued audio chunks`);
        
        // Process all queued audio
        for (const audioChunk of session.audioQueue) {
          if (session.deepgramConnection.readyState === WebSocket.OPEN) {
            session.deepgramConnection.send(audioChunk);
            session.audioStats.totalChunksProcessed++;
          }
        }
        
        // Clear the queue
        session.audioQueue = [];
      }
    });
    
    session.deepgramConnection.on('message', async (data) => {
      try {
        const response = JSON.parse(data);
        
        // Check if this is a transcript
        if (response.type === 'Results' && 
            response.channel && 
            response.channel.alternatives && 
            response.channel.alternatives.length > 0) {
          
          const transcript = response.channel.alternatives[0].transcript;
          
          // Only process if we have actual text
          if (transcript && transcript.trim()) {
            console.log(`🎤 Transcript: "${transcript}"`);
            
            // Add to conversation history
            session.conversationHistory.push(transcript);
            
            // Don't process if we're already generating a response
            if (session.isProcessingResponse) {
              console.log('⏳ Already processing a response, marking as pending');
              session.pendingResponse = true;
              return;
            }
            
            session.isProcessingResponse = true;
            
            try {
              // Generate AI response
              const aiResponse = await generateAIResponse(session, transcript);
              
              if (aiResponse) {
                console.log('AI response result received');
                console.log(`🤖 AI response: ${aiResponse}`);
                
                // Add to conversation history
                session.conversationHistory.push(aiResponse);
                
                // Log conversation turn to database
                await logConversationTurn(session, transcript, aiResponse);
                
                // Generate TTS for the response
                const ttsAudio = await generateDeepgramTTS(aiResponse);
                
                if (ttsAudio) {
                  // Send audio back to Twilio
                  await sendAudioToTwilio(session, ttsAudio);
                } else {
                  console.error('❌ Failed to generate TTS for AI response');
                }
              } else {
                console.error('❌ Failed to generate AI response');
              }
            } catch (error) {
              console.error('❌ Error processing transcript:', error);
            } finally {
              session.isProcessingResponse = false;
              
              // Check if we have a pending response to process
              if (session.pendingResponse) {
                console.log('⏳ Processing pending response');
                session.pendingResponse = false;
                
                // Get the last user message from history
                const lastUserMessage = session.conversationHistory[session.conversationHistory.length - 2];
                
                if (lastUserMessage) {
                  // Process it
                  session.isProcessingResponse = true;
                  
                  try {
                    // Generate AI response
                    const aiResponse = await generateAIResponse(session, lastUserMessage);
                    
                    if (aiResponse) {
                      console.log('AI response result received for pending message');
                      console.log(`🤖 AI response: ${aiResponse}`);
                      
                      // Add to conversation history
                      session.conversationHistory.push(aiResponse);
                      
                      // Log conversation turn to database
                      await logConversationTurn(session, lastUserMessage, aiResponse);
                      
                      // Generate TTS for the response
                      const ttsAudio = await generateDeepgramTTS(aiResponse);
                      
                      if (ttsAudio) {
                        // Send audio back to Twilio
                        await sendAudioToTwilio(session, ttsAudio);
                      } else {
                        console.error('❌ Failed to generate TTS for pending AI response');
                      }
                    } else {
                      console.error('❌ Failed to generate AI response for pending message');
                    }
                  } catch (error) {
                    console.error('❌ Error processing pending transcript:', error);
                  } finally {
                    session.isProcessingResponse = false;
                  }
                }
              }
            }
          }
        }
      } catch (error) {
        console.error('❌ Error parsing Deepgram response:', error);
      }
    });
    
    session.deepgramConnection.on('error', (error) => {
      console.error('❌ Deepgram connection error:', error);
      session.deepgramReady = false;
      
      // Try to reconnect
      if (session.reconnectionAttempts < session.maxReconnectionAttempts) {
        reconnectDeepgramSTT(session);
      }
    });
    
    session.deepgramConnection.on('close', (code, reason) => {
      console.log(`🎙️ Deepgram connection closed: code=${code}, reason=${reason || 'No reason provided'}`);
      session.deepgramReady = false;
      
      // Try to reconnect if session is still active
      if (session.isActive && session.reconnectionAttempts < session.maxReconnectionAttempts) {
        reconnectDeepgramSTT(session);
      }
    });
    
    return true;
  } catch (error) {
    console.error('❌ Error initializing Deepgram connection:', error);
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
  
  console.log(`🔄 Attempting to reconnect to Deepgram (attempt ${session.reconnectionAttempts}/${session.maxReconnectionAttempts})`);
  
  // Exponential backoff
  const backoffTime = Math.min(1000 * Math.pow(2, session.reconnectionAttempts - 1), 10000);
  console.log(`⏳ Waiting ${backoffTime}ms before reconnecting...`);
  
  await new Promise(resolve => setTimeout(resolve, backoffTime));
  
  return await initializeDeepgramConnection(session);
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
      console.error(`❌ Failed to send greeting after ${session.maxGreetingAttempts} attempts`);
      return false;
    }
    
    console.log(`🤖 Sending greeting message (attempt ${session.greetingAttempts}/${session.maxGreetingAttempts})`);
    
    // Default greeting message
    const greeting = "Hello! This is Caring Clarity's AI assistant. How can I help you schedule an appointment today?";
    
    // Add to conversation history
    session.conversationHistory.push(greeting);
    
    // Generate TTS for the greeting
    const ttsAudio = await generateDeepgramTTS(greeting);
    
    if (ttsAudio) {
      // Send audio back to Twilio
      const result = await sendAudioToTwilio(session, ttsAudio);
      
      if (result) {
        session.welcomeMessageSent = true;
        console.log('✅ Greeting message sent successfully');
        return true;
      } else {
        console.error('❌ Failed to send greeting audio to Twilio');
        
        // Try again after a delay if we haven't reached the maximum attempts
        if (session.greetingAttempts < session.maxGreetingAttempts) {
          console.log(`⏳ Will retry sending greeting in 2 seconds...`);
          setTimeout(() => sendGreetingMessage(session), 2000);
        }
        
        return false;
      }
    } else {
      console.error('❌ Failed to generate TTS for greeting');
      
      // Try again after a delay if we haven't reached the maximum attempts
      if (session.greetingAttempts < session.maxGreetingAttempts) {
        console.log(`⏳ Will retry sending greeting in 2 seconds...`);
        setTimeout(() => sendGreetingMessage(session), 2000);
      }
      
      return false;
    }
  } catch (error) {
    console.error('❌ Error sending greeting message:', error);
    return false;
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
    console.log('🧠 Generating AI response...');
    
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
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'llama3-8b-8192',
            messages: messages,
            temperature: 0.7,
            max_tokens: 800,
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          if (data.choices && data.choices.length > 0) {
            return data.choices[0].message.content;
          } else {
            console.error('❌ Groq API returned empty choices array');
            lastError = new Error('Empty choices array');
          }
        } else {
          const errorText = await response.text();
          console.error(`❌ Groq API error (attempt ${retryCount + 1}/${maxRetries}):`, 
                        response.status, response.statusText, errorText);
          lastError = new Error(`HTTP ${response.status}: ${errorText}`);
        }
      } catch (error) {
        clearTimeout(timeoutId);
        console.error(`❌ Groq API error (attempt ${retryCount + 1}/${maxRetries}):`, error);
        lastError = error;
      }
      
      retryCount++;
      if (retryCount < maxRetries) {
        // Exponential backoff
        const backoffTime = Math.min(1000 * Math.pow(2, retryCount - 1), 5000);
        console.log(`Waiting ${backoffTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }
    
    console.error('❌ All Groq API attempts failed:', lastError);
    return null;
  } catch (error) {
    console.error('❌ Error generating AI response:', error);
    return null;
  }
}

/**
 * Generate TTS audio using Deepgram
 * @param {string} text - The text to convert to speech
 * @returns {Promise<Buffer|null>} - Audio buffer or null if failed
 */
async function generateDeepgramTTS(text) {
  try {
    console.log('🎤 Generating Deepgram TTS for:', text);
    
    // Add retry logic
    const maxRetries = 3;
    let retryCount = 0;
    let lastError = null;
    
    while (retryCount < maxRetries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
        
        // FIXED: Updated TTS endpoint to use aura-asteria-en model explicitly
        const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000', {
          method: 'POST',
          headers: {
            'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: text,
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const audioBuffer = Buffer.from(await response.arrayBuffer());
          console.log('✅ Deepgram TTS generated successfully');
          return audioBuffer;
        } else {
          const errorText = await response.text();
          console.error(`❌ Deepgram TTS failed (attempt ${retryCount + 1}/${maxRetries}):`, 
                        response.status, response.statusText, errorText);
          lastError = new Error(`HTTP ${response.status}: ${errorText}`);
        }
      } catch (error) {
        clearTimeout(timeoutId);
        console.error(`❌ Deepgram TTS error (attempt ${retryCount + 1}/${maxRetries}):`, error);
        lastError = error;
      }
      
      retryCount++;
      if (retryCount < maxRetries) {
        // Exponential backoff
        const backoffTime = Math.min(1000 * Math.pow(2, retryCount - 1), 5000);
        console.log(`Waiting ${backoffTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }
    
    console.error('❌ All Deepgram TTS attempts failed:', lastError);
    return null;
  } catch (error) {
    console.error('❌ Deepgram TTS error:', error);
    return null;
  }
}

/**
 * Send audio to Twilio with proper mark header and media format
 * @param {Object} session - The session object
 * @param {Buffer} audioBuffer - The audio buffer to send
 * @returns {Promise<boolean>} - True if successful
 */
async function sendAudioToTwilio(session, audioBuffer) {
  try {
    // Check if we have a streamSid
    if (!session.streamSid) {
      console.error('❌ Cannot send audio to Twilio: No streamSid available');
      return false;
    }
    
    // Check if WebSocket is open
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      console.error('❌ Cannot send audio to Twilio: WebSocket not open');
      return false;
    }
    
    // Convert audio to base64 for Twilio
    const base64Audio = audioBuffer.toString('base64');
    
    // Create a unique mark name for this audio chunk
    const markName = `response-${Date.now()}-${session.outboundChunkCounter}`;
    
    // Send media message back to Twilio stream with proper format
    const mediaMessage = {
      event: 'media',
      streamSid: session.streamSid,
      media: {
        track: "outbound",
        chunk: session.outboundChunkCounter++,
        timestamp: Date.now(),
        payload: base64Audio,
        streamSid: session.streamSid  // Include streamSid in media object too
      },
      // Add mark header which is required by Twilio for outbound audio
      mark: {
        name: markName
      }
    };
    
    // Log detailed information about the audio being sent
    console.log(`🔊 Sending audio to Twilio: ${audioBuffer.length} bytes, chunk ${session.outboundChunkCounter - 1}, mark: ${markName}`);
    
    // Send through WebSocket back to Twilio
    session.ws.send(JSON.stringify(mediaMessage));
    console.log('🔊 Audio response sent to Twilio');
    return true;
  } catch (error) {
    console.error('❌ Error sending audio to Twilio:', error);
    return false;
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
    // FIXED: Only attempt to log if we have both messages
    if (!userMessage || !aiResponse) {
      console.log('⚠️ Skipping conversation logging due to missing messages');
      return false;
    }
    
    // FIXED: Ensure we're using the proper Supabase client without credentials in URL
    try {
      const { error } = await supabase.from('conversation_turns').insert({
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
      
      console.log('💾 Conversation logged to database');
      return true;
    } catch (error) {
      console.error('❌ Error logging conversation:', error);
      return false;
    }
  } catch (error) {
    console.error('❌ Error logging conversation:', error);
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
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        event: 'error',
        error: {
          code,
          message
        }
      }));
      console.log(`📤 Sent error to client: ${code} - ${message}`);
    }
  } catch (error) {
    console.error('❌ Error sending error message to client:', error);
  }
}

/**
 * Clean up session resources
 * @param {string} sessionId - The session ID
 */
async function cleanupSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    // Clear any intervals
    if (session.pingInterval) {
      clearInterval(session.pingInterval);
    }
    
    // Close Deepgram connection
    if (session.deepgramConnection) {
      try {
        session.deepgramConnection.close();
      } catch (error) {
        console.error('❌ Error closing Deepgram connection:', error);
      }
    }
    
    // Log session stats
    console.log(`📊 Session stats for ${sessionId}:`, {
      totalAudioChunksReceived: session.audioStats.totalChunksReceived,
      totalAudioChunksProcessed: session.audioStats.totalChunksProcessed,
      queueHighWaterMark: session.audioStats.queueHighWaterMark,
      conversationTurns: session.conversationHistory.length / 2,
      reconnectionAttempts: session.reconnectionAttempts,
      greetingAttempts: session.greetingAttempts,
      outboundChunks: session.outboundChunkCounter - 1
    });
    
    // Remove from active sessions
    activeSessions.delete(sessionId);
    console.log(`🧹 Cleaned up session: ${sessionId}`);
  }
}

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now();
  let staleSessions = 0;
  
  activeSessions.forEach((session, sessionId) => {
    // If no activity for 5 minutes, clean up
    if (now - session.lastActivityTimestamp > 5 * 60 * 1000) {
      console.log(`⏰ Cleaning up stale session: ${sessionId}`);
      cleanupSession(sessionId);
      staleSessions++;
    }
  });
  
  if (staleSessions > 0) {
    console.log(`🧹 Cleaned up ${staleSessions} stale sessions`);
  }
}, 60 * 1000); // Check every minute

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  
  // Close all active sessions
  activeSessions.forEach((session, sessionId) => {
    cleanupSession(sessionId);
  });
  
  wss.close(() => {
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  // Continue running - don't exit
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled promise rejection:', reason);
  // Continue running - don't exit
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/stream`);
  console.log(`🔍 Health check: http://localhost:${PORT}/health`);
  console.log(`🧪 Debug page: http://localhost:${PORT}/debug`);
});
