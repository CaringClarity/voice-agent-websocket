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
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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
    }
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

  ws.on('error', (error) => {
    console.error(`❌ WebSocket error for session ${sessionId}:`, error);
    clearInterval(session.pingInterval);
    cleanupSession(sessionId);
  });
});

/**
 * Initialize Deepgram WebSocket connection for speech-to-text
 * @param {Object} session - The session object
 * @returns {Promise<boolean>} - True if connection was successful
 */
async function initializeDeepgramConnection(session) {
  try {
    console.log('🎯 Initializing Deepgram connection...');

    // Create WebSocket connection to Deepgram with proper URL parameters
    // FIXED: Reverted to original working parameters from previous version
    const deepgramUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
      encoding: 'mulaw',
      sample_rate: '8000',
      channels: '1',
      model: 'nova-2', // Reverted to original model
      language: 'en-US',
      interim_results: 'true', // Changed to true as in working version
      punctuate: 'true',
      utterance_end_ms: '1000',
      endpointing: '300'
    });

    console.log('Connecting to Deepgram:', deepgramUrl);

    // Log API key length for debugging (without revealing the key)
    const apiKeyLength = process.env.DEEPGRAM_API_KEY ? process.env.DEEPGRAM_API_KEY.length : 0;
    console.log(`Using Deepgram API key with length: ${apiKeyLength} characters`);

    const deepgramWs = new WebSocket(deepgramUrl, {
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
      },
    });

    // Set connection timeout
    const connectionTimeout = setTimeout(() => {
      if (deepgramWs.readyState !== WebSocket.OPEN) {
        console.error('❌ Deepgram connection timeout');
        deepgramWs.terminate();
      }
    }, 10000);

    // Handle connection open
    deepgramWs.on('open', () => {
      clearTimeout(connectionTimeout);
      console.log('✅ Connected to Deepgram with proper audio configuration');
      
      // Mark as ready and process queued audio
      session.deepgramReady = true;
      session.reconnectionAttempts = 0;
      console.log(`🚀 Deepgram ready! Processing ${session.audioQueue.length} queued audio chunks`);
      
      // Send all queued audio
      while (session.audioQueue.length > 0) {
        const audioBuffer = session.audioQueue.shift();
        if (deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(audioBuffer);
          session.audioStats.totalChunksProcessed++;
          console.log('📤 Sent queued audio chunk to Deepgram');
        }
      }
      
      // Send greeting if needed and we have the streamSid
      if (!session.welcomeMessageSent && session.streamSid) {
        sendGreetingMessage(session);
      }
    });

    // Handle transcription results
    deepgramWs.on('message', async (message) => {
      try {
        const response = JSON.parse(message);
        console.log('📝 Deepgram response received');
        
        // FIXED: Updated to match the working version's response handling
        let transcript = "";
        let isFinal = false;

        // Handle response format from working version
        if (response.channel?.alternatives?.[0]?.transcript) {
          transcript = response.channel.alternatives[0].transcript;
          isFinal = !!response.is_final;
          
          console.log('🎯 Deepgram transcript:', transcript, 'isFinal:', isFinal);
        }
        
        if (transcript && transcript.length > 0) {
          if (isFinal) {
            console.log('📝 Final transcript:', transcript);
            
            if (session.isProcessingResponse) {
              session.pendingResponse = true;
              return;
            }
            
            session.isProcessingResponse = true;
            
            try {
              // Process with AI
              const aiResponse = await generateAIResponse(transcript, session);
              
              if (aiResponse) {
                // Generate audio with Deepgram TTS
                const audioBuffer = await generateDeepgramTTS(aiResponse);
                
                if (audioBuffer) {
                  // Send audio back to Twilio
                  const success = await sendAudioToTwilio(session, audioBuffer);
                  
                  if (success) {
                    // Update conversation history
                    session.conversationHistory.push(
                      { role: "user", content: transcript },
                      { role: "assistant", content: aiResponse }
                    );
                    
                    // Log conversation
                    await logConversationTurn(session, transcript, aiResponse);
                  } else {
                    console.error('❌ Failed to send audio to Twilio');
                  }
                } else {
                  console.error('❌ Failed to generate TTS audio');
                  // Notify client of error
                  sendErrorToClient(session, 'TTS_GENERATION_FAILED', 'Failed to generate speech from text');
                }
              } else {
                console.error('❌ Failed to generate AI response');
                // Notify client of error
                sendErrorToClient(session, 'AI_RESPONSE_FAILED', 'Failed to generate AI response');
              }
              
              if (session.pendingResponse) {
                session.pendingResponse = false;
                setTimeout(() => {
                  session.isProcessingResponse = false;
                }, 100);
              } else {
                session.isProcessingResponse = false;
              }
            } catch (error) {
              console.error('❌ Error generating response:', error);
              session.isProcessingResponse = false;
              // Notify client of error
              sendErrorToClient(session, 'RESPONSE_GENERATION_ERROR', 'Error processing your request');
            }
          } else {
            console.log('📝 Interim transcript:', transcript);
          }
        }
      } catch (error) {
        console.error('❌ Deepgram message error:', error);
      }
    });

    deepgramWs.on('error', async (error) => {
      clearTimeout(connectionTimeout);
      console.error('❌ Deepgram connection error:', error);
      
      // FIXED: Enhanced error logging for Deepgram errors
      if (error.response) {
        try {
          const errorBody = await error.response.text();
          console.error('Deepgram error details:', errorBody);
        } catch (e) {
          console.error('Could not parse Deepgram error details:', e);
        }
      }
      
      session.deepgramReady = false;
      
      // Attempt reconnection
      if (session.reconnectionAttempts < session.maxReconnectionAttempts) {
        await reconnectDeepgramSTT(session);
      } else {
        // Notify client that we've exhausted reconnection attempts
        sendErrorToClient(session, 'DEEPGRAM_CONNECTION_FAILED', 'Speech recognition service unavailable after multiple attempts');
      }
    });

    deepgramWs.on('close', async (code, reason) => {
      clearTimeout(connectionTimeout);
      console.log(`🔌 Deepgram connection closed: ${code} - ${reason}`);
      session.deepgramReady = false;
      
      // Attempt reconnection on unexpected closure
      if (code !== 1000 && session.reconnectionAttempts < session.maxReconnectionAttempts) {
        await reconnectDeepgramSTT(session);
      }
    });

    session.deepgramConnection = deepgramWs;
    return true;

  } catch (error) {
    console.error('❌ Failed to initialize Deepgram:', error);
    return false;
  }
}

/**
 * Reconnect to Deepgram STT service
 * @param {Object} session - The session object
 * @returns {Promise<boolean>} - True if reconnection was successful
 */
async function reconnectDeepgramSTT(session) {
  session.reconnectionAttempts++;
  console.log(`Attempting to reconnect Deepgram STT (attempt ${session.reconnectionAttempts}/${session.maxReconnectionAttempts})`);
  
  // Close existing connection if any
  if (session.deepgramConnection) {
    try {
      session.deepgramConnection.close();
    } catch (err) {
      console.error("Error closing existing Deepgram connection:", err);
    }
  }
  
  // Reset connection state
  session.deepgramReady = false;
  
  // Wait before reconnecting with exponential backoff
  const backoffTime = Math.min(1000 * Math.pow(2, session.reconnectionAttempts - 1), 10000);
  console.log(`Waiting ${backoffTime}ms before reconnection attempt`);
  await new Promise(resolve => setTimeout(resolve, backoffTime));
  
  // Try to initialize a new connection
  return await initializeDeepgramConnection(session);
}

/**
 * Send greeting message to the client
 * @param {Object} session - The session object
 * @returns {Promise<void>}
 */
async function sendGreetingMessage(session) {
  try {
    if (session.welcomeMessageSent || !session.streamSid) {
      return;
    }
    
    session.greetingAttempts++;
    console.log(`Sending greeting (attempt ${session.greetingAttempts}/${session.maxGreetingAttempts})...`);
    
    // Get tenant configuration if possible
    let greeting = "Hello! Thank you for calling Caring Clarity Counseling. I am Clara, your AI assistant. How can I help you today?";
    
    try {
      // Try to get tenant-specific configuration
      if (session.tenantId) {
        const { data: tenant, error } = await supabase
          .from("tenants")
          .select("settings")
          .eq("id", session.tenantId)
          .single();

        if (error) {
          throw error;
        }

        if (tenant?.settings?.voice_agent?.greeting) {
          greeting = tenant.settings.voice_agent.greeting;
        }
      }
    } catch (error) {
      console.error('❌ Error fetching tenant greeting, using default:', error);
    }
    
    // Generate audio with Deepgram TTS
    const audioBuffer = await generateDeepgramTTS(greeting);
    
    if (audioBuffer) {
      // Send audio back to Twilio
      const success = await sendAudioToTwilio(session, audioBuffer);
      
      if (success) {
        console.log('✅ Greeting sent successfully with Deepgram voice');
        session.welcomeMessageSent = true;
        
        // Add to conversation history
        session.conversationHistory.push(
          { role: "assistant", content: greeting }
        );
      } else {
        console.error('❌ Failed to send greeting');
        
        // Retry if we haven't exceeded max attempts
        if (session.greetingAttempts < session.maxGreetingAttempts) {
          console.log(`Will retry greeting in 1 second (attempt ${session.greetingAttempts}/${session.maxGreetingAttempts})`);
          setTimeout(() => sendGreetingMessage(session), 1000);
        }
      }
    } else {
      console.error('❌ Failed to generate greeting audio');
      
      // Retry if we haven't exceeded max attempts
      if (session.greetingAttempts < session.maxGreetingAttempts) {
        console.log(`Will retry greeting in 1 second (attempt ${session.greetingAttempts}/${session.maxGreetingAttempts})`);
        setTimeout(() => sendGreetingMessage(session), 1000);
      }
    }
  } catch (error) {
    console.error('❌ Error sending greeting:', error);
    
    // Retry if we haven't exceeded max attempts
    if (session.greetingAttempts < session.maxGreetingAttempts) {
      console.log(`Will retry greeting in 1 second (attempt ${session.greetingAttempts}/${session.maxGreetingAttempts})`);
      setTimeout(() => sendGreetingMessage(session), 1000);
    }
  }
}

/**
 * Generate AI response using Groq
 * @param {string} transcript - The user's transcript
 * @param {Object} session - The session object
 * @returns {Promise<string|null>} - The AI response or null if failed
 */
async function generateAIResponse(transcript, session) {
  try {
    console.log('🤖 Generating AI response for:', transcript);
    
    // Get tenant configuration if possible
    let systemPrompt = `You are Clara, a warm and professional intake assistant for a mental health practice. 
     Keep responses conversational, concise, and natural for speech. 
     Avoid special characters or formatting. 
     Aim for 1-3 sentences unless more detail is requested.
     
     Your role is to:
     1. Gather basic intake information from new clients
     2. Schedule appointments  
     3. Take messages for the counselor
     4. Provide general information about services
     5. Handle crisis situations by directing to emergency services
     
     Always maintain a warm, professional tone and respect confidentiality.`;
    
    try {
      // Try to get tenant-specific configuration
      if (session.tenantId) {
        const { data: tenant, error } = await supabase
          .from("tenants")
          .select("id")
          .eq("business_type", "counseling")
          .single();

        if (error) {
          throw error;
        }

        if (tenant?.id) {
          const { data: agentConfig, error: configError } = await supabase
            .from("agent_configs")
            .select("*")
            .eq("tenant_id", tenant.id)
            .eq("active", true)
            .single();
            
          if (configError) {
            throw configError;
          }
            
          if (agentConfig?.system_prompt) {
            systemPrompt = agentConfig.system_prompt;
          }
        }
      }
    } catch (error) {
      console.error('❌ Error fetching agent config, using default prompt:', error);
    }

    // Generate AI response using Groq with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
    
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // FIXED: Updated to use a currently supported model
          model: 'llama-3.1-70b', // Changed from 'llama-3.1-70b-versatile' to 'llama-3.1-70b'
          messages: [
            {
              role: 'system',
              content: systemPrompt
            },
            ...session.conversationHistory.slice(-10), // Keep last 10 messages for context
            { role: 'user', content: transcript }
          ],
          max_tokens: 150,
          temperature: 0.7,
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Groq API error: ${response.status} ${response.statusText}`, errorText);
        return "I'm sorry, I'm having trouble processing your request right now. Could you please try again?";
      }

      const result = await response.json();
      console.log('AI response result received');
      
      const aiMessage = result.choices?.[0]?.message?.content;

      if (aiMessage) {
        console.log('🤖 AI response:', aiMessage);
        return aiMessage;
      } else {
        console.error('❌ Empty AI response:', result);
        return "I'm sorry, I didn't catch that. Could you please repeat?";
      }
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        console.error('❌ AI response timeout');
        return "I'm sorry, it's taking me longer than expected to process your request. Could you please try again?";
      }
      throw error;
    }
  } catch (error) {
    console.error('❌ AI response error:', error);
    return "I'm sorry, I didn't catch that. Could you please repeat?";
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
        console.log(`Waiting ${backoffTime}ms before TTS retry`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }
    }
    
    console.error(`❌ Deepgram TTS failed after ${maxRetries} attempts:`, lastError);
    return null;
  } catch (error) {
    console.error('❌ Deepgram TTS error:', error);
    return null;
  }
}

/**
 * Send audio to Twilio
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
    
    // Send media message back to Twilio stream
    const mediaMessage = {
      event: 'media',
      streamSid: session.streamSid,
      media: {
        payload: base64Audio
      }
    };
    
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
      greetingAttempts: session.greetingAttempts
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
