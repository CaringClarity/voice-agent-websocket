const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Check required environment variables
const requiredEnvVars = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY', 
  'DEEPGRAM_API_KEY',
  'GROQ_API_KEY'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

console.log('✅ All environment variables loaded');

// Initialize Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Create WebSocket server
const wss = new WebSocket.Server({ 
  server,
  path: '/stream'
});

// Store active sessions
const activeSessions = new Map();

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const callSid = url.searchParams.get('callSid');
  const tenantId = url.searchParams.get('tenantId');
  const userId = url.searchParams.get('userId');

  console.log(`📞 New WebSocket connection: ${callSid}`);

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
    audioQueue: []
  };

  activeSessions.set(callSid, session);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log(`📨 Received event: ${data.event}`);
      await handleTwilioMessage(ws, session, data);
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

async function handleTwilioMessage(ws, session, data) {
  const { event, media, streamSid } = data;

  switch (event) {
    case 'connected':
      console.log('🔗 Twilio stream connected');
      break;

    case 'start':
      console.log('🎙️ Bidirectional stream started');
      session.streamSid = streamSid;
      await initializeDeepgramConnection(session);
      break;

    case 'media':
      if (media?.payload && media.track === 'inbound') {
        console.log(`🎵 Received audio chunk: ${media.payload.length} bytes`);
        
        // Convert from base64
        const audioBuffer = Buffer.from(media.payload, 'base64');
        
        // Check if Deepgram is ready
        if (session.deepgramReady && session.deepgramConnection && session.deepgramConnection.readyState === WebSocket.OPEN) {
          session.deepgramConnection.send(audioBuffer);
        } else {
          // Queue audio until Deepgram is ready
          session.audioQueue.push(audioBuffer);
          console.log(`📦 Queued audio chunk (queue size: ${session.audioQueue.length})`);
        }
      }
      break;

    case 'stop':
      console.log('🛑 Stream stopped');
      await cleanupSession(session.callSid);
      break;
  }
}

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
      interim_results: 'true',
      punctuate: 'true',
      utterance_end_ms: '1000',
      endpointing: '300'
    });

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
      console.log(`🚀 Deepgram ready! Processing ${session.audioQueue.length} queued audio chunks`);
      
      // Send all queued audio
      while (session.audioQueue.length > 0) {
        const audioBuffer = session.audioQueue.shift();
        if (deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(audioBuffer);
        }
      }
    });

    // Handle transcription results
    deepgramWs.on('message', async (message) => {
      try {
        const response = JSON.parse(message);
        console.log('🎯 Deepgram response:', JSON.stringify(response, null, 2));
        
        if (response.channel && response.channel.alternatives && response.channel.alternatives.length > 0) {
          const transcript = response.channel.alternatives[0].transcript;
          
          if (transcript && transcript.length > 0) {
            if (response.is_final) {
              console.log('📝 Final transcript:', transcript);
              
              // Process with AI
              const aiResponse = await generateAIResponse(transcript, session);
              
              if (aiResponse) {
                // Generate audio with Deepgram TTS
                const audioBuffer = await generateDeepgramTTS(aiResponse);
                
                if (audioBuffer) {
                  // Send audio back to Twilio
                  await sendAudioToTwilio(session, audioBuffer);
                }
              }
            } else {
              console.log('📝 Interim transcript:', transcript);
            }
          }
        }
      } catch (error) {
        console.error('❌ Deepgram message error:', error);
      }
    });

    deepgramWs.on('error', (error) => {
      console.error('❌ Deepgram connection error:', error);
      session.deepgramReady = false;
    });

    deepgramWs.on('close', (code, reason) => {
      console.log(`🔌 Deepgram connection closed: ${code} - ${reason}`);
      session.deepgramReady = false;
    });

    session.deepgramConnection = deepgramWs;

  } catch (error) {
    console.error('❌ Failed to initialize Deepgram:', error);
  }
}

async function generateAIResponse(transcript, session) {
  try {
    console.log('🤖 Generating AI response for:', transcript);
    
    // Add to conversation history
    session.conversationHistory.push({
      role: 'user',
      content: transcript,
      timestamp: new Date()
    });

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
            content: `You are Clara, a compassionate AI assistant for Caring Clarity Counseling. 
            Provide brief, empathetic responses (1-2 sentences max) to help callers with their mental health inquiries. 
            Be warm, professional, and supportive. If someone needs immediate help, direct them to emergency services.`
          },
          ...session.conversationHistory.slice(-10) // Keep last 10 messages for context
        ],
        max_tokens: 100,
        temperature: 0.7,
      }),
    });

    const result = await response.json();
    const aiMessage = result.choices?.[0]?.message?.content;

    if (aiMessage) {
      console.log('🤖 AI response:', aiMessage);
      
      // Add AI response to history
      session.conversationHistory.push({
        role: 'assistant',
        content: aiMessage,
        timestamp: new Date()
      });

      // Log conversation to database
      await logConversationTurn(session, transcript, aiMessage);

      return aiMessage;
    }

  } catch (error) {
    console.error('❌ AI response error:', error);
    return "I'm sorry, I didn't catch that. Could you please repeat?";
  }

  return null;
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
      console.error('❌ Deepgram TTS failed:', response.status, response.statusText);
    }
  } catch (error) {
    console.error('❌ Deepgram TTS error:', error);
  }
  return null;
}

async function sendAudioToTwilio(session, audioBuffer) {
  try {
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
    } else {
      console.error('❌ WebSocket not open for sending audio');
    }
    
  } catch (error) {
    console.error('❌ Error sending audio to Twilio:', error);
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
  } catch (error) {
    console.error('❌ Error logging conversation:', error);
  }
}

function cleanupSession(callSid) {
  const session = activeSessions.get(callSid);
  if (session) {
    if (session.deepgramConnection) {
      session.deepgramConnection.close();
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
      process.exit(0);
    });
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 WebSocket server running on port ${PORT}`);
  console.log(`📡 WebSocket endpoint: ws://localhost:${PORT}/stream`);
});
