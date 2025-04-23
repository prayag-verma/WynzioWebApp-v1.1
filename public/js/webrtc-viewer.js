/**
 * WebRTC Viewer for Wynzio
 * Handles screen viewing and remote control functionality
 */
const WynzioWebRTC = (function() {
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
  
  // Configuration - matches Windows app settings
  const config = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ],
    sdpSemantics: 'unified-plan',
    iceCandidatePoolSize: 10
  };
  
  // Singleton instance
  let instance = null;
  
  /**
   * WebRTC Client Class
   */
  class WebRTCClient {
    /**
     * Initialize the WebRTC viewer
     * @param {Object} options - Configuration options
     */
    initialize(options = {}) {
      // Set configuration
      if (options.iceServers) {
        config.iceServers = options.iceServers;
      }
      
      // Set socket if provided
      if (options.socket) {
        socket = options.socket;
        this.setupSocketHandlers();
      }
      
      // Set view element
      if (options.viewerElement) {
        this.setViewerElement(options.viewerElement);
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
        connect: this.connect.bind(this),
        disconnect: this.disconnect.bind(this),
        isConnected: () => isConnected,
        enableControls: this.enableControls.bind(this),
        disableControls: this.disableControls.bind(this),
        sendControlCommand: this.sendControlCommand.bind(this)
      };
    }
    
    /**
     * Set viewer element
     * @param {HTMLElement|String} element - Viewer element or ID
     */
    setViewerElement(element) {
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
          this.setupMouseControls();
        }
      }
    }
    
    /**
     * Set up socket event handlers
     */
    setupSocketHandlers() {
      // Handle WebRTC signaling
      socket.on('offer', this.handleOffer.bind(this));
      socket.on('answer', this.handleAnswer.bind(this));
      socket.on('ice-candidate', this.handleIceCandidate.bind(this));
      socket.on('control-response', this.handleControlResponse.bind(this));
      
      // Handle message events (general purpose messaging)
      socket.on('message', (data) => {
        // Route based on message type
        if (data.type === 'offer') {
          this.handleOffer(data);
        } else if (data.type === 'answer') {
          this.handleAnswer(data);
        } else if (data.type === 'ice-candidate') {
          this.handleIceCandidate(data);
        }
      });
      
      // Handle connection status updates
      socket.on('device-status-update', (data) => {
        if (data.deviceId === deviceId && data.status !== 'online' && isConnected) {
          // Device went offline or idle while connected
          this.disconnect();
          connectionCallbacks.onDisconnected('Device went offline');
        }
      });
    }
    
    /**
     * Connect to a device
     * @param {String} targetDeviceId - Device ID to connect to
     * @returns {Promise} Connection result
     */
    async connect(targetDeviceId) {
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
            await this.disconnect();
          }
          
          // Notify connecting
          connectionCallbacks.onConnecting();
          
          // Create peer connection
          peerConnection = new RTCPeerConnection(config);
          
          // Set up event handlers
          peerConnection.ontrack = this.handleTrack.bind(this);
          peerConnection.onicecandidate = this.handleLocalIceCandidate.bind(this);
          peerConnection.oniceconnectionstatechange = this.handleIceConnectionStateChange.bind(this);
          
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
          
          // Create offer - match the format used by Windows app
          const offer = await peerConnection.createOffer({
            offerToReceiveAudio: false,
            offerToReceiveVideo: true
          });
          
          // Set local description
          await peerConnection.setLocalDescription(offer);
          
          // Send offer to device - format matches WindowsApp
          socket.emit('offer', {
            targetId: deviceId,
            offer: {
              sdp: peerConnection.localDescription.sdp,
              type: peerConnection.localDescription.type
            }
          });
          
          // Resolve promise with connection methods
          resolve({
            disconnect: this.disconnect.bind(this),
            sendControlCommand: this.sendControlCommand.bind(this)
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
    async disconnect() {
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
    async handleOffer(data) {
      try {
        // Extract offer from different possible formats
        let offerSdp, offerType, fromId;
        
        // Format 1: { deviceId, offer: { sdp, type } }
        if (data.deviceId && data.offer) {
          offerSdp = data.offer.sdp;
          offerType = data.offer.type;
          fromId = data.deviceId;
        }
        // Format 2: { from, to, payload: { sdp, type } }
        else if (data.from && data.to && data.payload) {
          offerSdp = data.payload.sdp;
          offerType = data.payload.type;
          fromId = data.from;
        }
        // Invalid format
        else {
          throw new Error('Invalid offer format');
        }
        
        // Skip if not for this client or from wrong device
        if (fromId !== deviceId) {
          return;
        }
        
        // Create answer
        const offerDesc = new RTCSessionDescription({
          sdp: offerSdp,
          type: offerType
        });
        
        await peerConnection.setRemoteDescription(offerDesc);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        // Send answer - format matches WindowsApp
        socket.emit('answer', {
          targetId: deviceId,
          answer: {
            sdp: peerConnection.localDescription.sdp,
            type: peerConnection.localDescription.type
          }
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
    async handleAnswer(data) {
      try {
        // Extract answer from different possible formats
        let answerSdp, answerType, fromId;
        
        // Format 1: { deviceId, answer: { sdp, type } }
        if (data.deviceId && data.answer) {
          answerSdp = data.answer.sdp;
          answerType = data.answer.type;
          fromId = data.deviceId;
        }
        // Format 2: { from, to, payload: { sdp, type } }
        else if (data.from && data.to && data.payload) {
          answerSdp = data.payload.sdp;
          answerType = data.payload.type;
          fromId = data.from;
        }
        // Invalid format
        else {
          throw new Error('Invalid answer format');
        }
        
        // Skip if not for this client or from wrong device
        if (fromId !== deviceId) {
          return;
        }
        
        // Set remote description
        const answerDesc = new RTCSessionDescription({
          sdp: answerSdp,
          type: answerType
        });
        
        await peerConnection.setRemoteDescription(answerDesc);
      } catch (error) {
        console.error('Error handling answer:', error);
        connectionCallbacks.onError('Failed to process answer: ' + error.message);
      }
    }
    
    /**
     * Handle incoming ICE candidate
     * @param {Object} data - ICE candidate data
     */
    async handleIceCandidate(data) {
      try {
        // Extract candidate from different possible formats
        let candidateObj, fromId;
        
        // Format 1: { deviceId, candidate: { candidate, sdpMLineIndex, sdpMid } }
        if (data.deviceId && data.candidate) {
          candidateObj = data.candidate;
          fromId = data.deviceId;
        }
        // Format 2: { from, to, payload: { candidate, sdpMLineIndex, sdpMid } }
        else if (data.from && data.to && data.payload) {
          candidateObj = data.payload;
          fromId = data.from;
        }
        // Invalid format
        else {
          return; // Silently ignore invalid formats
        }
        
        // Skip if not for this client or from wrong device
        if (fromId !== deviceId) {
          return;
        }
        
        // Add ice candidate if valid
        if (candidateObj && candidateObj.candidate) {
          const candidate = new RTCIceCandidate({
            candidate: candidateObj.candidate,
            sdpMLineIndex: candidateObj.sdpMLineIndex,
            sdpMid: candidateObj.sdpMid
          });
          
          await peerConnection.addIceCandidate(candidate);
        }
      } catch (error) {
        console.error('Error handling ICE candidate:', error);
      }
    }
    
    /**
     * Handle local ICE candidate
     * @param {Object} event - ICE candidate event
     */
    handleLocalIceCandidate(event) {
      if (event.candidate) {
        // Send ICE candidate to peer - format matches Windows app
        socket.emit('ice-candidate', {
          targetId: deviceId,
          candidate: {
            candidate: event.candidate.candidate,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            sdpMid: event.candidate.sdpMid
          }
        });
      }
    }
    
    /**
     * Handle ICE connection state change
     */
    handleIceConnectionStateChange() {
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
    handleTrack(event) {
      if (streamElement && event.streams && event.streams[0]) {
        streamElement.srcObject = event.streams[0];
      }
    }
    
    /**
     * Handle control response
     * @param {Object} data - Control response data
     */
    handleControlResponse(data) {
      // Skip if not for this client or request
      if (data.deviceId !== deviceId) {
        return;
      }
      
      if (data.accepted) {
        console.log('Control access granted');
        
        // Enable controls if not already enabled
        if (!controlsEnabled) {
          this.enableControls();
        }
      } else {
        console.log('Control access denied');
        this.disableControls();
        connectionCallbacks.onError('Remote control access denied');
      }
    }
    
    /**
     * Enable mouse controls
     */
    enableControls() {
      if (!viewerElement || !streamElement) return;
      
      controlsEnabled = true;
      this.setupMouseControls();
    }
    
    /**
     * Disable mouse controls
     */
    disableControls() {
      if (!viewerElement || !streamElement) return;
      
      controlsEnabled = false;
      this.removeMouseControls();
    }
    
    /**
     * Set up mouse control event listeners
     */
    setupMouseControls() {
      if (!viewerElement || !streamElement) return;
      
      // Remove existing listeners
      this.removeMouseControls();
      
      // Add mouse event listeners
      streamElement.addEventListener('mousedown', this.handleMouseDown);
      streamElement.addEventListener('mouseup', this.handleMouseUp);
      streamElement.addEventListener('mousemove', this.handleMouseMove);
      streamElement.addEventListener('wheel', this.handleMouseWheel);
      streamElement.addEventListener('contextmenu', this.handleContextMenu);
      
      // Add keyboard event listeners to document
      document.addEventListener('keydown', this.handleKeyDown);
      document.addEventListener('keyup', this.handleKeyUp);
      
      // Add touch event listeners for mobile
      streamElement.addEventListener('touchstart', this.handleTouchStart);
      streamElement.addEventListener('touchend', this.handleTouchEnd);
      streamElement.addEventListener('touchmove', this.handleTouchMove);
    }
    
    /**
     * Remove mouse control event listeners
     */
    removeMouseControls() {
      if (!viewerElement || !streamElement) return;
      
      // Remove mouse event listeners
      streamElement.removeEventListener('mousedown', this.handleMouseDown);
      streamElement.removeEventListener('mouseup', this.handleMouseUp);
      streamElement.removeEventListener('mousemove', this.handleMouseMove);
      streamElement.removeEventListener('wheel', this.handleMouseWheel);
      streamElement.removeEventListener('contextmenu', this.handleContextMenu);
      
      // Remove keyboard event listeners
      document.removeEventListener('keydown', this.handleKeyDown);
      document.removeEventListener('keyup', this.handleKeyUp);
      
      // Remove touch event listeners
      streamElement.removeEventListener('touchstart', this.handleTouchStart);
      streamElement.removeEventListener('touchend', this.handleTouchEnd);
      streamElement.removeEventListener('touchmove', this.handleTouchMove);
    }
    
    /**
     * Send control command to device
     * Format exactly matches Windows app InputService.cs expectations
     * @param {Object} command - Control command
     */
    sendControlCommand(command) {
      if (!isConnected) {
        console.warn('Cannot send control command: not connected');
        return false;
      }
      
      try {
        // Send through data channel if available
        if (dataChannel && dataChannel.readyState === 'open') {
          dataChannel.send(JSON.stringify(command));
          return true;
        }
        
        // Fall back to signaling channel if data channel isn't available
        socket.emit('control-command', {
          deviceId: deviceId,
          command: command
        });
        
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
    getNormalizedCoordinates(event) {
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
  }
  
  // Event handlers - defined as properties of the prototype
  WebRTCClient.prototype.handleMouseDown = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    const coords = instance.getNormalizedCoordinates(event);
    if (!coords) return;
    
    let button;
    switch (event.button) {
      case 0: button = 'Left'; break;
      case 1: button = 'Middle'; break;
      case 2: button = 'Right'; break;
      default: button = 'Left';
    }
    
    // Format matches Windows InputService.cs
    instance.sendControlCommand({
      type: "MouseDown",
      button: button,
      x: coords.x,
      y: coords.y
    });
  };
  
  WebRTCClient.prototype.handleMouseUp = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    const coords = instance.getNormalizedCoordinates(event);
    if (!coords) return;
    
    let button;
    switch (event.button) {
      case 0: button = 'Left'; break;
      case 1: button = 'Middle'; break;
      case 2: button = 'Right'; break;
      default: button = 'Left';
    }
    
    // Format matches Windows InputService.cs
    instance.sendControlCommand({
      type: "MouseUp",
      button: button,
      x: coords.x,
      y: coords.y
    });
  };
  
  WebRTCClient.prototype.handleMouseMove = function(event) {
    if (!controlsEnabled || !isConnected) return;
    
    const coords = instance.getNormalizedCoordinates(event);
    if (!coords) return;
    
    // Throttle mouse move events to reduce load
    if (!instance.handleMouseMove.lastSent || Date.now() - instance.handleMouseMove.lastSent > 20) {
      // Format matches Windows InputService.cs
      instance.sendControlCommand({
        type: "MouseMove",
        x: coords.x,
        y: coords.y,
        isRelative: false
      });
      
      instance.handleMouseMove.lastSent = Date.now();
    }
  };
  
  WebRTCClient.prototype.handleMouseWheel = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    const delta = Math.sign(event.deltaY) * -1; // Invert delta for natural scrolling
    
    // Format matches Windows InputService.cs
    instance.sendControlCommand({
      type: "MouseScroll",
      scrollDelta: delta * 120 // Match Windows wheel delta
    });
  };
  
  WebRTCClient.prototype.handleContextMenu = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault(); // Prevent browser context menu
  };
  
  WebRTCClient.prototype.handleKeyDown = function(event) {
    if (!controlsEnabled || !isConnected) return;
    
    // Focus is on the viewer element or its within the document
    if (!event.target.closest('#screen-view') && event.target !== document.documentElement) {
      return;
    }
    
    // Ignore modifier key events
    if (event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift' || event.key === 'Meta') {
      return;
    }
    
    // Format matches Windows InputService.cs
    instance.sendControlCommand({
      type: "KeyDown",
      keyCode: event.keyCode
    });
  };
  
  WebRTCClient.prototype.handleKeyUp = function(event) {
    if (!controlsEnabled || !isConnected) return;
    
    // Focus is on the viewer element or its within the document
    if (!event.target.closest('#screen-view') && event.target !== document.documentElement) {
      return;
    }
    
    // Ignore modifier key events
    if (event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift' || event.key === 'Meta') {
      return;
    }
    
    // Format matches Windows InputService.cs
    instance.sendControlCommand({
      type: "KeyUp",
      keyCode: event.keyCode
    });
  };
  
  WebRTCClient.prototype.handleTouchStart = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    // Store touch start time for detecting long press
    instance.handleTouchStart.startTime = Date.now();
    instance.handleTouchStart.startPosition = {
      x: event.touches[0].clientX,
      y: event.touches[0].clientY
    };
    
    // Check if multiple touches (simulated right click)
    const button = event.touches.length > 1 ? 'Right' : 'Left';
    
    const coords = instance.getNormalizedCoordinates(event);
    if (!coords) return;
    
    // Format matches Windows InputService.cs
    instance.sendControlCommand({
      type: "MouseDown",
      button: button,
      x: coords.x,
      y: coords.y
    });
  };
  
  WebRTCClient.prototype.handleTouchEnd = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    // Calculate touch duration for long press detection
    const duration = Date.now() - (instance.handleTouchStart.startTime || 0);
    const button = duration > 500 ? 'Right' : 'Left'; // Long press as right click
    
    // Use the last known coordinates since there are no coordinates in touchend
    const coords = instance.getNormalizedCoordinates({
      type: 'touch',
      touches: [{
        clientX: instance.handleTouchStart.startPosition?.x || 0,
        clientY: instance.handleTouchStart.startPosition?.y || 0
      }]
    });
    
    if (!coords) return;
    
    // Format matches Windows InputService.cs
    instance.sendControlCommand({
      type: "MouseUp",
      button: button,
      x: coords.x,
      y: coords.y
    });
  };
  
  WebRTCClient.prototype.handleTouchMove = function(event) {
    if (!controlsEnabled || !isConnected) return;
    event.preventDefault();
    
    const coords = instance.getNormalizedCoordinates(event);
    if (!coords) return;
    
    // Throttle touch move events to reduce load
    if (!instance.handleTouchMove.lastSent || Date.now() - instance.handleTouchMove.lastSent > 50) {
      // Format matches Windows InputService.cs
      instance.sendControlCommand({
        type: "MouseMove",
        x: coords.x,
        y: coords.y,
        isRelative: false
      });
      
      instance.handleTouchMove.lastSent = Date.now();
    }
  };
  
  // Create and return singleton instance
  return {
    initialize: function(options) {
      if (!instance) {
        instance = new WebRTCClient();
      }
      return instance.initialize(options);
    }
  };
})();