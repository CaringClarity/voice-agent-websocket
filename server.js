const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

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
    conversationHistory: [],
    isActive: true
  };

  activeSessions.set(callSid, session);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
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
      console.log('🎙️ Stream started');
      await initializeDeepgramConnection(session);
      break;

    case 'media':
      if (media?.payload && session.deepgramConnection) {
        // Forward audio to Deepgram
        const audioBuffer = Buffer.from(media.payload, 'base64');
        session.deepgramConnection.send(audioBuffer);
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

    // Create WebSocket connection to Deepgram
    const deepgramWs = new WebSocket('wss://api.deepgram.com/v1/listen', {
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`,
      },
    });

    // Send configuration to Deepgram
    deepgramWs.on('open', () => {
      console.log('✅ Connected to Deepgram');
      deepgramWs.send(JSON.stringify({
        type: 'Configure',
        processors: {
          stt: {
            language: 'en',
            model: 'nova-2',
            interim_results: true,
            punctuate: true,
            utterance_end_ms: 1000,
            endpointing: 300,
          }
        }
      }));
    });

    // Handle transcription results
    deepgramWs.on('message', async (message) => {
      try {
        const response = JSON.parse(message);
        
        if (response.type === 'Results') {
          const transcript = response.channel?.alternatives?.[0]?.transcript;
          
          if (transcript && transcript.length > 0 && response.is_final) {
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
          }
        }
      } catch (error) {
        console.error('❌ Deepgram message error:', error);
      }
    });

    deepgramWs.on('error', (error) => {
      console.error('❌ Deepgram connection error:', error);
    });

    session.deepgramConnection = deepgramWs;

  } catch (error) {
    console.error('❌ Failed to initialize Deepgram:', error);
  }
}

async function generateAIResponse(transcript, session) {
  try {
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
    const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en', {
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
      return Buffer.from(await response.arrayBuffer());
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
    console.log('🔊 Sending audio response to Twilio');
    
    // Note: In a real implementation, you'd send this back through the Twilio WebSocket
    
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
