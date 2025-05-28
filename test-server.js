#!/usr/bin/env node

/**
 * Test script for Clarity AI Voice Server
 * This script validates the server's functionality by simulating Twilio WebSocket connections
 */

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// Configuration
const SERVER_URL = 'ws://localhost:3000/stream';
const TEST_DURATION_MS = 30000; // 30 seconds

// Generate test IDs
const callSid = `test-call-${uuidv4()}`;
const sessionId = `test-session-${uuidv4()}`;

console.log('🧪 Starting Clarity AI Voice Server test');
console.log(`📞 Call SID: ${callSid}`);
console.log(`🔑 Session ID: ${sessionId}`);

// Connect to WebSocket server
console.log(`🔌 Connecting to ${SERVER_URL}`);
const ws = new WebSocket(`${SERVER_URL}?callSid=${callSid}&sessionId=${sessionId}&tenantId=test&userId=test&sendGreeting=true`);

// Track test state
let testStartTime = null;
let receivedGreeting = false;
let receivedResponse = false;
let testPassed = false;
let testCompleted = false;

// Set up test timeout
const testTimeout = setTimeout(() => {
  if (!testCompleted) {
    console.error('❌ Test timed out');
    cleanup(1);
  }
}, TEST_DURATION_MS);

// Handle WebSocket events
ws.on('open', () => {
  console.log('✅ Connected to server');
  testStartTime = Date.now();
  
  // Send start event
  const startEvent = {
    event: 'start',
    start: {
      callSid: callSid,
      streamSid: `test-stream-${uuidv4()}`
    }
  };
  
  ws.send(JSON.stringify(startEvent));
  console.log('📤 Sent start event');
  
  // Schedule test audio after 2 seconds
  setTimeout(sendTestAudio, 2000);
});

ws.on('message', (data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log(`📥 Received: ${JSON.stringify(message, null, 2)}`);
    
    if (message.event === 'media' && message.media && message.media.payload) {
      if (!receivedGreeting) {
        console.log('✅ Received greeting audio');
        receivedGreeting = true;
      } else {
        console.log('✅ Received response audio');
        receivedResponse = true;
        
        // If we've received both greeting and response, test is successful
        if (receivedGreeting && receivedResponse) {
          testPassed = true;
          console.log('🎉 Test passed! Server is functioning correctly');
          cleanup(0);
        }
      }
    } else if (message.event === 'error') {
      console.error(`❌ Received error: ${message.error.code} - ${message.error.message}`);
    }
  } catch (error) {
    console.log(`📥 Received binary data of length: ${data.length}`);
  }
});

ws.on('error', (error) => {
  console.error(`❌ WebSocket error: ${error.message}`);
  cleanup(1);
});

ws.on('close', (code, reason) => {
  console.log(`🔌 Connection closed: ${code} ${reason || ''}`);
  if (!testCompleted) {
    cleanup(1);
  }
});

// Send test audio data
function sendTestAudio() {
  if (ws.readyState !== WebSocket.OPEN) {
    console.error('❌ WebSocket not open, cannot send test audio');
    return;
  }
  
  // Create a media event with test audio data
  // This simulates someone saying "Hello, can you help me schedule an appointment?"
  const mediaEvent = {
    event: 'media',
    media: {
      track: 'inbound',
      chunk: 1,
      timestamp: Date.now(),
      payload: Buffer.from('Hello, can you help me schedule an appointment?').toString('base64')
    }
  };
  
  ws.send(JSON.stringify(mediaEvent));
  console.log('📤 Sent test audio data');
}

// Clean up and exit
function cleanup(exitCode) {
  testCompleted = true;
  clearTimeout(testTimeout);
  
  const testDuration = Date.now() - testStartTime;
  console.log(`⏱️ Test duration: ${testDuration}ms`);
  
  if (ws.readyState === WebSocket.OPEN) {
    // Send stop event
    const stopEvent = {
      event: 'stop',
      stop: {
        callSid: callSid
      }
    };
    
    ws.send(JSON.stringify(stopEvent));
    console.log('📤 Sent stop event');
    
    // Close connection gracefully
    ws.close(1000, 'Test completed');
  }
  
  // Summary
  console.log('\n📋 Test Summary:');
  console.log(`Connection established: ${testStartTime ? '✅' : '❌'}`);
  console.log(`Greeting received: ${receivedGreeting ? '✅' : '❌'}`);
  console.log(`Response received: ${receivedResponse ? '✅' : '❌'}`);
  console.log(`Overall test result: ${testPassed ? '✅ PASSED' : '❌ FAILED'}`);
  
  // Exit after a short delay to allow WebSocket to close
  setTimeout(() => {
    process.exit(exitCode);
  }, 500);
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Test interrupted');
  cleanup(1);
});
