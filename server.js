/**
 * Enhanced WebSocket server with fixed Deepgram initialization
 * Resolves silent call issue and ensures welcome message plays
 */
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

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

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
  }
}

console.log('✅ Environment variables checked');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Create WebSocket server with explicit path
const wss = new WebSocket.Server({ 
  server,
  path: '/stream'
});

// Store active sessions
const activeSessions = new Map();

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0'
  });
});

// Environment variables check endpoint
app.get('/health/env', (req, res) => {
  // Check required environment variables
  const envStatus = {
    DEEPGRAM_API_KEY: !!process.env.DEEPGRAM_API_KEY,
    SUPABASE_URL: !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
    SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    GROQ_API_KEY: !!process.env.GROQ_API_KEY,
  };
  
  const missingVars = Object.entries(envStatus)
    .filter(([_, value]) => !value)
    .map(([key]) => key);
  
  if (missingVars.length > 0) {
    return res.json({
      status: "warning",
      message: "Some environment variables are missing",
      missingVars,
      timestamp: new Date().toISOString(),
    });
  }
  
  return res.json({
    status: "healthy",
    message: "All required environment variables are set",
    timestamp: new Date().toISOString(),
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
        pre { background-color: #f8f9fa; padding: 10px; border-radius: 5px; overflow: auto; }
        button { padding: 8px 16px; background-color: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background-color: #0069d9; }
      </style>
    </head>
    <body>
      <h1>WebSocket Connection Test</h1>
      <div id="status" class="connecting">Connecting...</div>
      <button id="reconnect">Reconnect</button>
      <h2>Connection Log</h2>
      <pre id="log"></pre>
      
      <script>
        const statusEl = document.getElementById('status');
        const logEl = document.getElementById('log');
        const reconnectBtn = document.getElementById('reconnect');
        let ws;
        
        function log(message) {
          const timestamp = new Date().toISOString();
          logEl.textContent = \`[\${timestamp}] \${message}\\n\` + logEl.textContent;
        }
        
        function connect() {
          statusEl.textContent = 'Connecting...';
          statusEl.className = 'connecting';
          
          // Create a test session ID
          const sessionId = 'test-session-' + Date.now();
          const callSid = 'test-call-' + Date.now();
          
          // Connect to the WebSocket server
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const wsUrl = \`\${protocol}//\${window.location.host}/stream?callSid=\${callSid}&tenantId=test&userId=test\`;
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
            log('Received: ' + event.data);
          };
        }
        
        reconnectBtn.addEventListener('click', () => {
          if (ws) {
            ws.close();
          }
          connect();
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
  const tenantId = url.searchParams.get('tenantId');
  const userId = url.searchParams.get('userId');

  console.log(`📞 New WebSocket connection: ${callSid}`);
  console.log(`URL parameters: callSid=${callSid}, tenantId=${tenantId}, userId=${userId}`);

  // Initialize session
  const session = {
    callSid,
    tenantId,
    userId,
    deepgramConnection: null,
    deepgramReady: false,
    conversationHistory: [],
    isActive: true,
    ws: ws,
    streamSid: null,
    audioQueue: [],
    welcomeMessageSent: false,
    reconnectionAttempts: 0,
    maxReconnectionAttempts: 3
  };

  activeSessions.set(callSid, session);

  // CRITICAL FIX: Initialize Deepgram immediately
  // Don't wait for start event which might not come
  console.log("🚀 Initializing Deepgram immediately on connection");
  await initializeDeepgramConnection(session);
  
  // Send welcome message after a short delay
  setTimeout(() => {
    if (!session.welcomeMessageSent) {
      console.log("🎤 Sending welcome message after connection");
      sendWelcomeMessage(session);
    }
  }, 1000);

  ws.on('message', async (message) => {
    try {
      console.log(`📥 Received raw message of length: ${message.length} bytes`);
      
      // Try to parse as JSON
      try {
        const data = JSON.parse(message);
        console.log(`📨 Received event: ${data.event}`);
        
        // Store streamSid if this is a start event
        if (data.event === 'start' && data.start && data.start.streamSid) {
          session.streamSid = data.start.streamSid;
          console.log(`🎙️ Stream started with SID: ${session.streamSid}`);
        }
        
        // Handle media event
        if (data.event === 'media' && data.media && data.media.payload && data.media.track === 'inbound') {
          // Convert from base64
          const audioBuffer = Buffer.from(data.media.payload, 'base64');
          
          // Check if Deepgram is ready
          if (session.deepgramReady && session.deepgramConnection && 
              session.deepgramConnection.readyState === WebSocket.OPEN) {
            session.deepgramConnection.send(audioBuffer);
            console.log('🎤 Forwarded audio to Deepgram');
          } else {
            // Queue audio until Deepgram is ready
            if (session.audioQueue.length < 500) {
              session.audioQueue.push(audioBuffer);
              console.log(`📦 Queued audio chunk (queue size: ${session.audioQueue.length})`);
            }
          }
        }
        
        // Handle stop event
        if (data.event === 'stop') {
          console.log('🛑 Stream stopped');
          await cleanupSession(session.callSid);
        }
      } catch (jsonError) {
        // Not JSON, might be binary audio data
        console.log(`📦 Received binary data, length: ${message.length} bytes`);
        
        // If Deepgram is ready, forward the audio
        if (session.deepgramReady && session.deepgramConnection && 
            session.deepgramConnection.readyState === WebSocket.OPEN) {
          session.deepgramConnection.send(message);
          console.log('🎤 Forwarded binary audio to Deepgram');
        } else {
          // Queue audio until Deepgram is ready
          if (session.audioQueue.length < 500) {
            session.audioQueue.push(message);
            console.log(`📦 Queued binary audio chunk (queue size: ${session.audioQueue.length})`);
          }
        }
      }
    } catch (error) {
      console.error('❌ WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    console.log(`📞 WebSocket closed: ${callSid}`);
    cleanupSession(callSid);
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
    cleanupSession(callSid);
  });
});

async function initializeDeepgramConnection(session) {
  try {
    console.log('🎯 Initializing Deepgram connection...');

    // Create WebSocket connection to Deepgram with proper URL parameters
    const deepgramUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
      encoding: 'mulaw',
      sample_rate: '8000',
      channels: '1',
      model: 'nova-2',
      language: 'en-US',
      interim_results: 'false',
      punctuate: 'true',
      smart_format: 'true',
      utterance_end_ms: '1000',
      endpointing: '300'
    });

    console.log('Connecting to Deepgram:', deepgramUrl);

    const deepgramWs = new WebSocket(deepgramUrl, {
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
      },
    });

    // Handle connection open
    deepgramWs.on('open', () => {
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
          console.log('📤 Sent queued audio chunk to Deepgram');
        }
      }
      
      // Check if welcome message should be sent
      if (!session.welcomeMessageSent) {
        console.log('🔊 Sending welcome message after Deepgram connection');
        sendWelcomeMessage(session);
      }
    });

    // Handle transcription results
    deepgramWs.on('message', async (message) => {
      try {
        const response = JSON.parse(message);
        console.log('📝 Deepgram response received');
        
        let transcript = "";
        let isFinal = false;

        // Handle different Deepgram response formats
        if (response.channel?.alternatives?.[0]?.transcript) {
          transcript = response.channel.alternatives[0].transcript;
          isFinal = !!response.is_final;
        } else if (response.alternatives?.[0]?.transcript) {
          transcript = response.alternatives[0].transcript;
          isFinal = !!response.is_final;
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
                  await sendAudioToTwilio(session, audioBuffer);
                  
                  // Update conversation history
                  session.conversationHistory.push(
                    { role: "user", content: transcript },
                    { role: "assistant", content: aiResponse }
                  );
                  
                  // Log conversation
                  await logConversationTurn(session, transcript, aiResponse);
                }
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
      console.error('❌ Deepgram connection error:', error);
      session.deepgramReady = false;
      
      // Attempt reconnection
      if (session.reconnectionAttempts < session.maxReconnectionAttempts) {
        await reconnectDeepgramSTT(session);
      }
    });

    deepgramWs.on('close', async (code, reason) => {
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

async function reconnectDeepgramSTT(session) {
  session.reconnectionAttempts++;
  console.log(`Attempting to reconnect Deepgram STT (attempt ${session.reconnectionAttempts})`);
  
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
  
  // Wait before reconnecting
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  // Try to initialize a new connection
  return await initializeDeepgramConnection(session);
}

async function sendWelcomeMessage(session) {
  try {
    // Skip if welcome message was already sent
    if (session.welcomeMessageSent) {
      console.log(`Welcome message already sent for call ${session.callSid}`);
      return;
    }
    
    const welcomeMessage = "Thank you for calling Caring Clarity Counseling, my name is Clara. How can I help you today?";
    console.log(`🎙️ Sending welcome message for call ${session.callSid}`);
    
    // Generate audio with Deepgram TTS
    const audioBuffer = await generateDeepgramTTS(welcomeMessage);
    
    if (audioBuffer) {
      // Send audio back to Twilio
      const success = await sendAudioToTwilio(session, audioBuffer);
      
      if (success) {
        // Add to conversation history
        session.conversationHistory.push({ role: "assistant", content: welcomeMessage });
        
        session.welcomeMessageSent = true;
        console.log(`✅ Welcome message sent for call ${session.callSid}`);
      } else {
        console.error(`❌ Failed to send welcome message for call ${session.callSid}`);
        // Try again after a delay
        setTimeout(() => {
          if (!session.welcomeMessageSent) {
            sendWelcomeMessage(session);
          }
        }, 2000);
      }
    } else {
      console.error(`❌ Failed to generate welcome message audio for call ${session.callSid}`);
    }
  } catch (error) {
    console.error('❌ Error sending welcome message:', error);
  }
}

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
      const { data: tenant } = await supabase
        .from("tenants")
        .select("id")
        .eq("business_type", "counseling")
        .single();

      if (tenant?.id) {
        const { data: agentConfig } = await supabase
          .from("agent_configs")
          .select("*")
          .eq("tenant_id", tenant.id)
          .eq("active", true)
          .single();
          
        if (agentConfig?.system_prompt) {
          systemPrompt = agentConfig.system_prompt;
        }
      }
    } catch (error) {
      console.error('❌ Error fetching agent config, using default prompt:', error);
    }

    // Generate AI response using Groq
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-70b-versatile',
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
    });

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
    console.error('❌ AI response error:', error);
    return "I'm sorry, I didn't catch that. Could you please repeat?";
  }
}

async function generateDeepgramTTS(text) {
  try {
    console.log('🎤 Generating Deepgram TTS for:', text);
    
    const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: text,
      }),
    });

    if (response.ok) {
      const audioBuffer = Buffer.from(await response.arrayBuffer());
      console.log('✅ Deepgram TTS generated successfully');
      return audioBuffer;
    } else {
      const errorText = await response.text();
      console.error('❌ Deepgram TTS failed:', response.status, response.statusText, errorText);
      return null;
    }
  } catch (error) {
    console.error('❌ Deepgram TTS error:', error);
    return null;
  }
}

async function sendAudioToTwilio(session, audioBuffer) {
  try {
    // Check if we have a streamSid
    if (!session.streamSid) {
      console.error('❌ Cannot send audio to Twilio: No streamSid available');
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
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(mediaMessage));
      console.log('🔊 Audio response sent to Twilio');
      return true;
    } else {
      console.error('❌ WebSocket not open for sending audio');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Error sending audio to Twilio:', error);
    return false;
  }
}

async function logConversationTurn(session, userMessage, aiResponse) {
  try {
    await supabase.from('conversation_turns').insert({
      conversation_id: session.callSid,
      user_message: userMessage,
      ai_response: aiResponse,
      timestamp: new Date().toISOString(),
      metadata: {
        tenant_id: session.tenantId,
        user_id: session.userId
      }
    });
    console.log('💾 Conversation logged to database');
    return true;
  } catch (error) {
    console.error('❌ Error logging conversation:', error);
    return false;
  }
}

function cleanupSession(callSid) {
  const session = activeSessions.get(callSid);
  if (session) {
    if (session.deepgramConnection) {
      try {
        session.deepgramConnection.close();
      } catch (error) {
        console.error('❌ Error closing Deepgram connection:', error);
      }
    }
    activeSessions.delete(callSid);
    console.log(`🧹 Cleaned up session: ${callSid}`);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  wss.close(() => {
    server.close(() => {
      console.log('✅ Server closed');
      process.exit(0);
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/stream`);
  console.log(`🔍 Health check: http://localhost:${PORT}/health`);
  console.log(`🧪 Debug page: http://localhost:${PORT}/debug`);
});
