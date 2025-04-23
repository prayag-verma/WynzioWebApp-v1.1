/**
 * device-manager.js
 * Handles device management and remote viewer functionality
 * Modified to align with Windows app expectations
 */

// Global variables
let devices = [];
let rtcClient = null;
let viewerSocket = null;
let sessionStartTime = null;
let sessionTimer = null;
let controlEnabled = true;
let clientId = 'web-client-' + Date.now(); // Unique client ID for this web client

document.addEventListener('DOMContentLoaded', async function() {
    try {
        // Check if authenticated - This assumes dashboard-ui.js is loaded first
        // and has already done the authentication check
        if (document.body.classList.contains('not-authenticated')) {
            return;
        }
        
        // Initialize device management
        await initDeviceManagement();
        
        // Initialize socket updates
        const socket = initSocketUpdates();
        
        // Add event listeners for viewer section
        initViewerControls();
    } catch (error) {
        console.error('Device management initialization error:', error);
    }
});

/**
 * Initialize device management
 */
async function initDeviceManagement() {
    // Add event listeners
    document.getElementById('refresh-devices-btn').addEventListener('click', fetchDevices);
    document.getElementById('status-filter').addEventListener('change', filterDevices);
    document.getElementById('device-search').addEventListener('input', filterDevices);
    
    // Fetch devices
    await fetchDevices();
    
    // Set up automatic refresh every 30 seconds
    setInterval(fetchDevices, 30000);
}

/**
 * Fetch devices from API
 */
async function fetchDevices() {
    try {
        const deviceList = document.getElementById('device-list');
        
        // Show loading indicator
        deviceList.innerHTML = `
            <div class="loading-devices">
                <div class="spinner">
                    <i class="fas fa-spinner fa-spin"></i>
                </div>
                <p>Loading devices...</p>
            </div>
        `;
        
        // Make API request
        const response = await fetch('/api/devices', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${Auth.getToken()}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch devices');
        }
        
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.message || 'Failed to fetch devices');
        }
        
        // Store devices
        devices = data.devices;
        
        // Filter and render devices
        filterDevices();
    } catch (error) {
        console.error('Error fetching devices:', error);
        
        // Show error message
        const deviceList = document.getElementById('device-list');
        deviceList.innerHTML = `
            <div class="device-list-error">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Failed to load devices. Please try again.</p>
                <button class="btn btn-sm" onclick="fetchDevices()">
                    <i class="fas fa-sync-alt"></i> Retry
                </button>
            </div>
        `;
    }
}

/**
 * Filter and render devices
 */
function filterDevices() {
    // Get filter values
    const statusFilter = document.getElementById('status-filter').value;
    const searchText = document.getElementById('device-search').value.toLowerCase();
    
    // Filter devices
    const filteredDevices = devices.filter(device => {
        // Status filter
        if (statusFilter !== 'all' && device.status !== statusFilter) {
            return false;
        }
        
        // Search filter
        if (searchText && !device.systemName.toLowerCase().includes(searchText)) {
            return false;
        }
        
        return true;
    });
    
    // Render devices
    renderDevices(filteredDevices);
}

/**
 * Render devices to DOM
 */
function renderDevices(filteredDevices) {
    const deviceList = document.getElementById('device-list');
    
    // Clear existing content
    deviceList.innerHTML = '';
    
    // Check if no devices
    if (filteredDevices.length === 0) {
        deviceList.innerHTML = `
            <div class="no-devices">
                <i class="fas fa-laptop-house"></i>
                <p>No devices found matching the filters.</p>
            </div>
        `;
        return;
    }
    
    // Create device cards
    filteredDevices.forEach(device => {
        const deviceCard = document.createElement('div');
        deviceCard.className = `device-card ${device.status}`;
        deviceCard.dataset.deviceId = device.deviceId;
        
        // Format last seen time
        const lastSeen = device.lastSeen ? formatTimeAgo(new Date(device.lastSeen)) : 'Never';
        
        // Create device card content
        deviceCard.innerHTML = `
            <div class="device-info">
                <div class="device-name">
                    <h4>${device.systemName}</h4>
                    <span class="device-id">${device.deviceId}</span>
                </div>
                <div class="device-status">
                    <span class="status-indicator ${device.status}"></span>
                    <span class="status-text">${capitalizeFirstLetter(device.status)}</span>
                </div>
            </div>
            <div class="device-meta">
                <span class="device-last-seen">
                    <i class="fas fa-clock"></i> Last seen: ${lastSeen}
                </span>
                <span class="device-connection">
                    <i class="fas fa-plug"></i> Connections: ${device.connections || 0}
                </span>
            </div>
            <div class="device-actions">
                <button class="btn btn-sm connect-btn" ${device.status !== 'online' ? 'disabled' : ''}>
                    <i class="fas fa-desktop"></i> Connect
                </button>
                <button class="btn btn-sm view-details-btn">
                    <i class="fas fa-info-circle"></i> Details
                </button>
            </div>
        `;
        
        // Add event listeners
        const connectBtn = deviceCard.querySelector('.connect-btn');
        connectBtn.addEventListener('click', () => {
            connectToDevice(device.deviceId);
        });
        
        const detailsBtn = deviceCard.querySelector('.view-details-btn');
        detailsBtn.addEventListener('click', () => {
            viewDeviceDetails(device.deviceId);
        });
        
        // Add to list
        deviceList.appendChild(deviceCard);
    });
}

/**
 * Connect to device
 */
function connectToDevice(deviceId) {
    // Show remote viewer section
    showRemoteViewerSection();
    
    // Initialize viewer with device ID
    initViewer(deviceId);
}

/**
 * Show device list section
 */
function showDeviceListSection() {
    document.getElementById('device-list-section').classList.add('active');
    document.getElementById('remote-viewer-section').classList.remove('active');
    
    // Update page title
    document.getElementById('page-title').textContent = 'Dashboard';
    
    // Refresh device list
    fetchDevices();
}

/**
 * Show remote viewer section
 */
function showRemoteViewerSection() {
    document.getElementById('device-list-section').classList.remove('active');
    document.getElementById('remote-viewer-section').classList.add('active');
    
    // Update page title
    document.getElementById('page-title').textContent = 'Remote Viewer';
}

/**
 * View device details
 */
function viewDeviceDetails(deviceId) {
    // Implement device details modal or page
    // For now, just open connection page
    connectToDevice(deviceId);
}

/**
 * Format time ago
 */
function formatTimeAgo(date) {
    const now = new Date();
    const diff = now - date;
    
    // Less than a minute
    if (diff < 60000) {
        return 'Just now';
    }
    
    // Less than an hour
    if (diff < 3600000) {
        const minutes = Math.floor(diff / 60000);
        return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
    }
    
    // Less than a day
    if (diff < 86400000) {
        const hours = Math.floor(diff / 3600000);
        return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    }
    
    // Less than a week
    if (diff < 604800000) {
        const days = Math.floor(diff / 86400000);
        return `${days} ${days === 1 ? 'day' : 'days'} ago`;
    }
    
    // Format date
    return date.toLocaleDateString();
}

/**
 * Capitalize first letter
 */
function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

/**
 * Initialize socket for real-time updates
 */
function initSocketUpdates() {
    // Connect to Socket.IO server with client ID matching Windows app expectations
    const socket = io('', {
        query: {
            type: 'dashboard',
            clientId: clientId // Use the globally defined client ID
        },
        auth: {
            token: Auth.getToken()
        }
    });
    
    // Listen for device status updates
    socket.on('device-status-update', (data) => {
        // Find device in list
        const deviceIndex = devices.findIndex(d => d.deviceId === data.deviceId);
        
        if (deviceIndex !== -1) {
            // Update device status
            devices[deviceIndex].status = data.status;
            devices[deviceIndex].lastSeen = data.timestamp;
            
            // Update UI if already rendered
            const deviceCard = document.querySelector(`.device-card[data-device-id="${data.deviceId}"]`);
            if (deviceCard) {
                // Update status classes
                deviceCard.className = `device-card ${data.status}`;
                
                // Update status indicator
                const statusIndicator = deviceCard.querySelector('.status-indicator');
                if (statusIndicator) {
                    statusIndicator.className = `status-indicator ${data.status}`;
                }
                
                // Update status text
                const statusText = deviceCard.querySelector('.status-text');
                if (statusText) {
                    statusText.textContent = capitalizeFirstLetter(data.status);
                }
                
                // Update last seen
                const lastSeen = deviceCard.querySelector('.device-last-seen');
                if (lastSeen) {
                    lastSeen.innerHTML = `<i class="fas fa-clock"></i> Last seen: ${formatTimeAgo(new Date(data.timestamp))}`;
                }
                
                // Update connect button
                const connectBtn = deviceCard.querySelector('.connect-btn');
                if (connectBtn) {
                    if (data.status === 'online') {
                        connectBtn.removeAttribute('disabled');
                    } else {
                        connectBtn.setAttribute('disabled', 'disabled');
                    }
                }
            }
        } else {
            // New device, refetch all devices
            fetchDevices();
        }
    });
    
    // Handle device-list response
    socket.on('device-list', (deviceList) => {
        // Update devices
        devices = deviceList;
        
        // Filter and render devices
        filterDevices();
    });
    
    // Listen for connection error
    socket.on('connection-error', (data) => {
        console.error('Connection error:', data.error);
        showError(data.error || 'Failed to connect to device');
    });
    
    // Listen for socket disconnect
    socket.on('disconnect', () => {
        console.log('Socket disconnected');
    });
    
    // Listen for socket reconnect
    socket.on('connect', () => {
        console.log('Socket reconnected');
        
        // Refetch devices
        fetchDevices();
    });
    
    return socket;
}

/**
 * Initialize viewer controls
 */
function initViewerControls() {
    // Back button
    document.getElementById('back-to-devices-button').addEventListener('click', function() {
        disconnectFromDevice();
        showDeviceListSection();
    });
    
    // Control toggle button
    document.getElementById('control-toggle').addEventListener('click', toggleControl);
    
    // Fullscreen button
    document.getElementById('fullscreen-button').addEventListener('click', toggleFullscreen);
    
    // Refresh button
    document.getElementById('refresh-button').addEventListener('click', refreshConnection);
    
    // Disconnect button
    document.getElementById('disconnect-button').addEventListener('click', function() {
        disconnectFromDevice();
        showDeviceListSection();
    });
    
    // Retry button
    document.getElementById('retry-button').addEventListener('click', function() {
        const currentDeviceId = document.getElementById('retry-button').getAttribute('data-device-id');
        if (currentDeviceId) {
            initViewer(currentDeviceId);
        }
    });
}

/**
 * Initialize the remote viewer
 * @param {string} deviceId - Device ID to connect to
 */
async function initViewer(deviceId) {
    try {
        // Show loading indicator
        document.getElementById('loading-indicator').classList.remove('hidden');
        document.getElementById('connection-error').classList.add('hidden');
        document.getElementById('screen-view').innerHTML = '';
        
        // Update connection status
        document.getElementById('connection-status').textContent = 'Connecting...';
        
        // Store device ID for retry button
        document.getElementById('retry-button').setAttribute('data-device-id', deviceId);
        
        // Disconnect existing connection if any
        disconnectFromDevice();
        
        // Fetch device information
        await fetchDeviceInfo(deviceId);
        
        // Connect to Socket.IO server with consistent client ID
        viewerSocket = io('', {
            query: {
                type: 'dashboard',
                clientId: clientId
            },
            auth: {
                token: Auth.getToken()
            }
        });
        
        // Wait for socket connection
        await new Promise((resolve, reject) => {
            viewerSocket.on('connect', resolve);
            viewerSocket.on('connect_error', reject);
            viewerSocket.on('error', reject);
            
            // Set timeout for connection
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 10000);
            
            // Clear timeout on connect
            viewerSocket.on('connect', () => clearTimeout(timeout));
        });
        
        // Initialize WebRTC client with config matching Windows app expectations
        rtcClient = WynzioWebRTC.initialize({
            socket: viewerSocket,
            viewerElement: 'screen-view',
            deviceId: deviceId,
            clientId: clientId, // Use consistent client ID
            enableControls: controlEnabled,
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ],
            onConnecting: () => {
                document.getElementById('connection-status').textContent = 'Establishing WebRTC connection...';
            },
            onConnected: () => {
                // Hide loading indicator
                document.getElementById('loading-indicator').classList.add('hidden');
                
                // Update connection status
                document.getElementById('connection-status').textContent = 'Connected';
                
                // Start session timer
                startSessionTimer();
                
                // Update control button state
                updateControlButtonState();
            },
            onDisconnected: (reason) => {
                document.getElementById('connection-status').textContent = 'Disconnected: ' + (reason || 'Unknown reason');
                
                // Stop session timer
                if (sessionTimer) {
                    clearInterval(sessionTimer);
                    sessionTimer = null;
                }
                
                // Show connection error
                showError('Connection closed: ' + (reason || 'Unknown reason'));
            },
            onError: (error) => {
                console.error('WebRTC error:', error);
                showError(error);
            }
        });
        
        // Send connection request to initiate the WebRTC process
        // This matches the API call expected by the server
        const response = await fetch(`/api/devices/${deviceId}/connect`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${Auth.getToken()}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to initiate connection');
        }
        
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.message || 'Failed to initiate connection');
        }
        
        // Send request-connection via socket to initiate WebRTC connection
        viewerSocket.emit('request-connection', {
            deviceId: deviceId,
            requestId: data.requestId || 'req-' + Date.now()
        });
        
        // Connect WebRTC client
        await rtcClient.connect(deviceId);
        
        // Request device status update
        viewerSocket.emit('device-status-request', {
            deviceId: deviceId
        });
    } catch (error) {
        console.error('Error connecting to device:', error);
        showError(error.message || 'Failed to connect to device');
    }
}

/**
 * Fetch device information from the API
 * @param {string} deviceId - Device ID
 */
async function fetchDeviceInfo(deviceId) {
    try {
        const response = await fetch(`/api/devices/${deviceId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${Auth.getToken()}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch device information');
        }
        
        const data = await response.json();
        
        if (!data.success) {
            throw new Error(data.message || 'Failed to fetch device information');
        }
        
        // Update UI with device information
        document.getElementById('device-name').textContent = data.device.systemName;
        updateDeviceStatus(data.device.status);
    } catch (error) {
        console.error('Error fetching device information:', error);
        throw error;
    }
}

/**
 * Update device status indicator
 * @param {string} status - Device status
 */
function updateDeviceStatus(status) {
    const statusElement = document.getElementById('device-status');
    
    // Remove all status classes
    statusElement.classList.remove('online', 'offline', 'idle');
    
    // Add appropriate class
    statusElement.classList.add(status);
    
    // Update text
    statusElement.textContent = status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Show connection error
 * @param {string} message - Error message
 */
function showError(message) {
    // Hide loading indicator
    document.getElementById('loading-indicator').classList.add('hidden');
    
    // Show error message
    const errorElement = document.getElementById('connection-error');
    errorElement.classList.remove('hidden');
    
    // Update error message
    document.getElementById('error-message').textContent = message;
}

/**
 * Start session timer
 */
function startSessionTimer() {
    // Set session start time
    sessionStartTime = new Date();
    
    // Update timer display
    updateSessionTime();
    
    // Start timer interval
    sessionTimer = setInterval(updateSessionTime, 1000);
}

/**
 * Update session time display
 */
function updateSessionTime() {
    if (!sessionStartTime) return;
    
    const now = new Date();
    const diff = now - sessionStartTime;
    
    // Calculate hours, minutes, seconds
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    
    // Format time string
    const timeString = [
        hours.toString().padStart(2, '0'),
        minutes.toString().padStart(2, '0'),
        seconds.toString().padStart(2, '0')
    ].join(':');
    
    // Update display
    document.getElementById('session-time').textContent = timeString;
}

/**
 * Toggle remote control
 */
function toggleControl() {
    if (!rtcClient) return;
    
    controlEnabled = !controlEnabled;
    
    if (controlEnabled) {
        rtcClient.enableControls();
    } else {
        rtcClient.disableControls();
    }
    
    // Update button state
    updateControlButtonState();
}

/**
 * Update control button state
 */
function updateControlButtonState() {
    const button = document.getElementById('control-toggle');
    
    if (controlEnabled) {
        button.classList.add('active');
        button.title = 'Disable Remote Control';
    } else {
        button.classList.remove('active');
        button.title = 'Enable Remote Control';
    }
}

/**
 * Toggle fullscreen mode
 */
function toggleFullscreen() {
    const container = document.getElementById('screen-container');
    
    if (!document.fullscreenElement) {
        // Enter fullscreen
        if (container.requestFullscreen) {
            container.requestFullscreen();
        } else if (container.webkitRequestFullscreen) {
            container.webkitRequestFullscreen();
        } else if (container.msRequestFullscreen) {
            container.msRequestFullscreen();
        }
        
        // Update button
        document.getElementById('fullscreen-button').innerHTML = '<i class="fas fa-compress"></i>';
        document.getElementById('fullscreen-button').title = 'Exit Fullscreen';
    } else {
        // Exit fullscreen
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
        
        // Update button
        document.getElementById('fullscreen-button').innerHTML = '<i class="fas fa-expand"></i>';
        document.getElementById('fullscreen-button').title = 'Fullscreen';
    }
}

/**
 * Refresh connection
 */
function refreshConnection() {
    const deviceId = document.getElementById('retry-button').getAttribute('data-device-id');
    if (deviceId) {
        initViewer(deviceId);
    }
}

/**
 * Disconnect from device
 */
function disconnectFromDevice() {
    // Disconnect WebRTC if active
    if (rtcClient) {
        rtcClient.disconnect();
        rtcClient = null;
    }
    
    // Disconnect socket if active
    if (viewerSocket) {
        viewerSocket.disconnect();
        viewerSocket = null;
    }
    
    // Clear session timer if active
    if (sessionTimer) {
        clearInterval(sessionTimer);
        sessionTimer = null;
    }
    
    // Reset session start time
    sessionStartTime = null;
    
    // Reset session time display
    document.getElementById('session-time').textContent = '00:00:00';
    
    // Reset connection status
    document.getElementById('connection-status').textContent = 'Disconnected';
}

// Handle page unload
window.addEventListener('beforeunload', function() {
    // Disconnect from device if connected
    disconnectFromDevice();
});