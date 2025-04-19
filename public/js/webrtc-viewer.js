/**
 * WebRTC Viewer for Wynzio
 * Handles screen viewing and remote control functionality
 */
const WynzioWebRTC = (function() {
    // Configuration
    const config = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ],
      sdpSemantics: 'unified-plan'
    };
    
    // Private variables
    let socket = null;
    let peerConnection = null;
    let deviceId = null;
    let isConnected = false;
    let viewerElement = null;
    let streamElement = null;
    let controlsEnabled = false;
    let connectionCallbacks = {};
    let dataChannel = null;
    
    /**
     * Initialize the WebRTC viewer
     * @param {Object} options - Configuration options
     */
    function initialize(options = {}) {
      // Set configuration
      if (options.iceServers) {
        config.iceServers = options.iceServers;
      }
      
      // Set socket if provided
      if (options.socket) {
        socket = options.socket;
        setupSocketHandlers();
      }
      
      // Set view element
      if (options.viewerElement) {
        setViewerElement(options.viewerElement);
      }
      
      // Set initial device ID
      if (options.deviceId) {
        deviceId = options.deviceId;
      }
      
      // Set connection callbacks
      connectionCallbacks = {
        onConnecting: options.onConnecting || function() {},
        onConnected: options.onConnected || function() {},
        onDisconnected: options.onDisconnected || function() {},
        onError: options.onError || function() {}
      };
      
      // Enable controls by default unless explicitly disabled
      controlsEnabled = options.enableControls !== false;
      
      return {
        connect: connect,
        disconnect: disconnect,
        isConnected: () => isConnected,
        enableControls: enableControls,
        disableControls: disableControls
      };
    }
    
    /**
     * Set viewer element
     * @param {HTMLElement|String} element - Viewer element or ID
     */
    function setViewerElement(element) {
      if (typeof element === 'string') {
        viewerElement = document.getElementById(element);
      } else {
        viewerElement = element;
      }
      
      // Create video element if not already exists
      if (viewerElement && !streamElement) {
        streamElement = document.createElement('video');
        streamElement.autoplay = true;
        streamElement.muted = true;
        streamElement.style.width = '100%';
        streamElement.style.height = 'auto';
        
        // Add stream element to viewer
        viewerElement.appendChild(streamElement);
        
        // Add mouse event listeners if controls enabled
        if (controlsEnabled) {
          setupMouseControls();
        }
      }
    }
    
    /**
     * Set up socket event handlers
     */
    function setupSocketHandlers() {
      // Handle WebRTC signaling
      socket.on('offer', handleOffer);
      socket.on('answer', handleAnswer);
      socket.on('ice-candidate', handleIceCandidate);
      socket.on('control-response', handleControlResponse);
      
      // Handle connection status updates
      socket.on('device-status-update', (data) => {
        if (data.deviceId === deviceId && data.status !== 'online' && isConnected) {
          // Device went offline or idle while connected
          disconnect();
          connectionCallbacks.onDisconnected('Device went offline');
        }
      });
    }
    
    /**
     * Connect to a device
     * @param {String} targetDeviceId - Device ID to connect to
     * @returns {Promise} Connection result
     */
    function connect(targetDeviceId) {
      return new Promise(async (resolve, reject) => {
        try {
          // Validate requirements
          if (!socket) {
            throw new Error('Socket not initialized');
          }
          
          if (!viewerElement) {
            throw new Error('Viewer element not set');
          }
          
          // Update device ID if provided
          if (targetDeviceId) {
            deviceId = targetDeviceId;
          }
          
          if (!deviceId) {
            throw new Error('No device ID specified');
          }
          
          // Disconnect if already connected
          if (isConnected) {
            await disconnect();
          }
          
          // Notify connecting
          connectionCallbacks.onConnecting();
          
          // Create peer connection
          peerConnection = new RTCPeerConnection(config);
          
          // Set up event handlers
          peerConnection.ontrack = handleTrack;
          peerConnection.onicecandidate = handleLocalIceCandidate;
          peerConnection.oniceconnectionstatechange = handleIceConnectionStateChange;
          
          // Create data channel for control commands
          dataChannel = peerConnection.createDataChannel('control', {
            ordered: true
          });
          
          dataChannel.onopen = () => {
            console.log('Data channel opened');
          };
          
          dataChannel.onclose = () => {
            console.log('Data channel closed');
          };
          
          dataChannel.onerror = (error) => {
            console.error('Data channel error:', error);
          };
          
          // Create offer
          const offer = await peerConnection.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: true
          });
          
          // Set local description
          await peerConnection.setLocalDescription(offer);
          
          // Send offer to device
          socket.emit('offer', {
            targetId: deviceId,
            offer: peerConnection.localDescription
          });
          
          // Resolve promise with connection methods
          resolve({
            disconnect,
            sendControlCommand
          });
        } catch (error) {
          console.error('Connection error:', error);
          connectionCallbacks.onError(error.message);
          reject(error);
        }
      });
    }
    
    /**
     * Disconnect from device
     */
    async function disconnect() {
      try {
        // Close peer connection
        if (peerConnection) {
          peerConnection.ontrack = null;
          peerConnection.onicecandidate = null;
          peerConnection.oniceconnectionstatechange = null;
          
          // Close all transceivers
          const transceivers = peerConnection.getTransceivers();
          transceivers.forEach(transceiver => {
            if (transceiver.stop) {
              transceiver.stop();
            }
          });
          
          // Close peer connection
          peerConnection.close();
          peerConnection = null;
        }
        
        // Clear video element
        if (streamElement) {
          if (streamElement.srcObject) {
            const tracks = streamElement.srcObject.getTracks();
            tracks.forEach(track => track.stop());
            streamElement.srcObject = null;
          }
        }
        
        // Clear data channel
        dataChannel = null;
        
        // Update state
        isConnected = false;
        
        // Notify disconnected
        connectionCallbacks.onDisconnected();
      } catch (error) {
        console.error('Disconnect error:', error);
      }
    }
    
    /**
     * Handle incoming WebRTC offer
     * @param {Object} data - Offer data
     */
    async function handleOffer(data) {
      try {
        // Skip if not for this client
        if (data.deviceId !== deviceId) {
          return;
        }
        
        // Create answer
        await peerConnection.setRemoteDescription(data.offer);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        // Send answer
        socket.emit('answer', {
          targetId: deviceId,
          answer: peerConnection.localDescription
        });
      } catch (error) {
        console.error('Error handling offer:', error);
        connectionCallbacks.onError('Failed to process offer: ' + error.message);
      }
    }
    
    /**
     * Handle incoming WebRTC answer
     * @param {Object} data - Answer data
     */
    async function handleAnswer(data) {
      try {
        // Skip if not for this client
        if (data.deviceId !== deviceId) {
          return;
        }
        
        // Set remote description
        await peerConnection.setRemoteDescription(data.answer);
      } catch (error) {
        console.error('Error handling answer:', error);
        connectionCallbacks.onError('Failed to process answer: ' + error.message);
      }
    }
    
    /**
     * Handle incoming ICE candidate
     * @param {Object} data - ICE candidate data
     */
    async function handleIceCandidate(data) {
      try {
        // Skip if not for this client
        if (data.deviceId !== deviceId) {
          return;
        }
        
        // Add ice candidate
        if (data.candidate) {
          await peerConnection.addIceCandidate(data.candidate);
        }
      } catch (error) {
        console.error('Error handling ICE candidate:', error);
      }
    }
    
    /**
     * Handle local ICE candidate
     * @param {Object} event - ICE candidate event
     */
    function handleLocalIceCandidate(event) {
      if (event.candidate) {
        socket.emit('ice-candidate', {
          targetId: deviceId,
          candidate: event.candidate
        });
      }
    }
    
    /**
     * Handle ICE connection state change
     */
    function handleIceConnectionStateChange() {
      if (!peerConnection) return;
      
      const state = peerConnection.iceConnectionState;
      console.log('ICE connection state:', state);
      
      switch (state) {
        case 'connected':
        case 'completed':
          if (!isConnected) {
            isConnected = true;
            connectionCallbacks.onConnected();
          }
          break;
        case 'failed':
        case 'disconnected':
        case 'closed':
          if (isConnected) {
            isConnected = false;
            connectionCallbacks.onDisconnected(state);
          }
          break;
      }
    }
    
    /**
     * Handle remote track
     * @param {Object} event - Track event
     */
    function handleTrack(event) {
      if (streamElement && event.streams && event.streams[0]) {
        streamElement.srcObject = event.streams[0];
      }
    }
    
    /**
     * Handle control response
     * @param {Object} data - Control response data
     */
    function handleControlResponse(data) {
      // Skip if not for this client or request
      if (data.deviceId !== deviceId) {
        return;
      }
      
      if (data.accepted) {
        console.log('Control access granted');
        
        // Enable controls if not already enabled
        if (!controlsEnabled) {
          enableControls();
        }
      } else {
        console.log('Control access denied');
        disableControls();
        connectionCallbacks.onError('Remote control access denied');
      }
    }
    
    /**
     * Enable mouse controls
     */
    function enableControls() {
      if (!viewerElement || !streamElement) return;
      
      controlsEnabled = true;
      setupMouseControls();
    }
    
    /**
     * Disable mouse controls
     */
    function disableControls() {
      if (!viewerElement || !streamElement) return;
      
      controlsEnabled = false;
      removeMouseControls();
    }
    
    /**
     * Set up mouse control event listeners
     */
    function setupMouseControls() {
      if (!viewerElement || !streamElement) return;
      
      // Remove existing listeners
      removeMouseControls();
      
      // Add mouse event listeners
      streamElement.addEventListener('mousedown', handleMouseDown);
      streamElement.addEventListener('mouseup', handleMouseUp);
      streamElement.addEventListener('mousemove', handleMouseMove);
      streamElement.addEventListener('wheel', handleMouseWheel);
      streamElement.addEventListener('contextmenu', handleContextMenu);
      
      // Add touch event listeners for mobile
      streamElement.addEventListener('touchstart', handleTouchStart);
      streamElement.addEventListener('touchend', handleTouchEnd);
      streamElement.addEventListener('touchmove', handleTouchMove);
    }
    
    /**
     * Remove mouse control event listeners
     */
    function removeMouseControls() {
      if (!viewerElement || !streamElement) return;
      
      // Remove mouse event listeners
      streamElement.removeEventListener('mousedown', handleMouseDown);
      streamElement.removeEventListener('mouseup', handleMouseUp);
      streamElement.removeEventListener('mousemove', handleMouseMove);
      streamElement.removeEventListener('wheel', handleMouseWheel);
      streamElement.removeEventListener('contextmenu', handleContextMenu);
      
      // Remove touch event listeners
      streamElement.removeEventListener('touchstart', handleTouchStart);
      streamElement.removeEventListener('touchend', handleTouchEnd);
      streamElement.removeEventListener('touchmove', handleTouchMove);
    }
    
    /**
     * Send control command to device
     * @param {Object} command - Control command
     */
    function sendControlCommand(command) {
      if (!isConnected || !dataChannel || dataChannel.readyState !== 'open') {
        console.warn('Cannot send control command: Data channel not open');
        return false;
      }
      
      try {
        dataChannel.send(JSON.stringify(command));
        return true;
      } catch (error) {
        console.error('Error sending control command:', error);
        return false;
      }
    }
    
    /**
     * Convert event coordinates to normalized coordinates
     * @param {Event} event - Mouse or touch event
     * @returns {Object} Normalized coordinates
     */
    function getNormalizedCoordinates(event) {
      const rect = streamElement.getBoundingClientRect();
      const scaleX = streamElement.videoWidth / rect.width;
      const scaleY = streamElement.videoHeight / rect.height;
      
      let x, y;
      
      if (event.type.startsWith('touch')) {
        // Touch event
        if (event.touches.length > 0) {
          x = (event.touches[0].clientX - rect.left) * scaleX;
          y = (event.touches[0].clientY - rect.top) * scaleY;
        } else {
          // Use last known position
          return null;
        }
      } else {
        // Mouse event
        x = (event.clientX - rect.left) * scaleX;
        y = (event.clientY - rect.top) * scaleY;
      }
      
      return {
        x: Math.round(x),
        y: Math.round(y)
      };
    }
    
    /**
     * Handle mouse down event
     * @param {Event} event - Mouse event
     */
    function handleMouseDown(event) {
      if (!controlsEnabled || !isConnected) return;
      event.preventDefault();
      
      const coords = getNormalizedCoordinates(event);
      if (!coords) return;
      
      let button;
      switch (event.button) {
        case 0: button = 'left'; break;
        case 1: button = 'middle'; break;
        case 2: button = 'right'; break;
        default: button = 'left';
      }
      
      sendControlCommand({
        type: 'mouse',
        action: 'down',
        x: coords.x,
        y: coords.y,
        button,
        isRelative: false
      });
    }
    
    /**
     * Handle mouse up event
     * @param {Event} event - Mouse event
     */
    function handleMouseUp(event) {
      if (!controlsEnabled || !isConnected) return;
      event.preventDefault();
      
      const coords = getNormalizedCoordinates(event);
      if (!coords) return;
      
      let button;
      switch (event.button) {
        case 0: button = 'left'; break;
        case 1: button = 'middle'; break;
        case 2: button = 'right'; break;
        default: button = 'left';
      }
      
      sendControlCommand({
        type: 'mouse',
        action: 'up',
        x: coords.x,
        y: coords.y,
        button,
        isRelative: false
      });
    }
    
    /**
     * Handle mouse move event
     * @param {Event} event - Mouse event
     */
    function handleMouseMove(event) {
      if (!controlsEnabled || !isConnected) return;
      
      const coords = getNormalizedCoordinates(event);
      if (!coords) return;
      
      // Throttle mouse move events to reduce load
      if (!handleMouseMove.lastSent || Date.now() - handleMouseMove.lastSent > 20) {
        sendControlCommand({
          type: 'mouse',
          action: 'move',
          x: coords.x,
          y: coords.y,
          isRelative: false
        });
        
        handleMouseMove.lastSent = Date.now();
      }
    }
    
    /**
     * Handle mouse wheel event
     * @param {Event} event - Wheel event
     */
    function handleMouseWheel(event) {
      if (!controlsEnabled || !isConnected) return;
      event.preventDefault();
      
      const delta = Math.sign(event.deltaY) * -1; // Invert delta for natural scrolling
      
      sendControlCommand({
        type: 'mouse',
        action: 'scroll',
        scrollDelta: delta
      });
    }
    
    /**
     * Handle context menu event (right click)
     * @param {Event} event - Context menu event
     */
    function handleContextMenu(event) {
      if (!controlsEnabled || !isConnected) return;
      event.preventDefault(); // Prevent browser context menu
    }
    
    /**
     * Handle touch start event
     * @param {Event} event - Touch event
     */
    function handleTouchStart(event) {
      if (!controlsEnabled || !isConnected) return;
      event.preventDefault();
      
      // Store touch start time for detecting long press
      handleTouchStart.startTime = Date.now();
      handleTouchStart.startPosition = {
        x: event.touches[0].clientX,
        y: event.touches[0].clientY
      };
      
      // Check if multiple touches (simulated right click)
      const button = event.touches.length > 1 ? 'right' : 'left';
      
      const coords = getNormalizedCoordinates(event);
      if (!coords) return;
      
      sendControlCommand({
        type: 'mouse',
        action: 'down',
        x: coords.x,
        y: coords.y,
        button,
        isRelative: false
      });
    }
    
    /**
     * Handle touch end event
     * @param {Event} event - Touch event
     */
    function handleTouchEnd(event) {
      if (!controlsEnabled || !isConnected) return;
      event.preventDefault();
      
      // Calculate touch duration for long press detection
      const duration = Date.now() - (handleTouchStart.startTime || 0);
      const button = duration > 500 ? 'right' : 'left'; // Long press as right click
      
      // Use the last known coordinates since there are no coordinates in touchend
      const coords = getNormalizedCoordinates({
        type: 'touch',
        touches: [{
          clientX: handleTouchStart.startPosition?.x || 0,
          clientY: handleTouchStart.startPosition?.y || 0
        }]
      });
      
      if (!coords) return;
      
      sendControlCommand({
        type: 'mouse',
        action: 'up',
        x: coords.x,
        y: coords.y,
        button,
        isRelative: false
      });
    }
    
    /**
     * Handle touch move event
     * @param {Event} event - Touch event
     */
    function handleTouchMove(event) {
      if (!controlsEnabled || !isConnected) return;
      event.preventDefault();
      
      const coords = getNormalizedCoordinates(event);
      if (!coords) return;
      
      // Throttle touch move events to reduce load
      if (!handleTouchMove.lastSent || Date.now() - handleTouchMove.lastSent > 50) {
        sendControlCommand({
          type: 'mouse',
          action: 'move',
          x: coords.x,
          y: coords.y,
          isRelative: false
        });
        
        handleTouchMove.lastSent = Date.now();
      }
    }
    
    // Public API
    return {
      initialize
    };
  })();