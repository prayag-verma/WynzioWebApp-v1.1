/**
 * Central configuration for Wynzio application
 */
const AppConfig = (function() {
    // Default configuration
    const defaultConfig = {
        apiUrl: '/api',
        authTokenKey: 'wynzio_auth_token',
        userDataKey: 'wynzio_user_data',
        configKey: 'wynzio_config',
        jwtSecret: process.env.JWT_SECRET || "3f7t9b20e8r143k0b2l10s6d19q74b1p",
        tokenRefreshInterval: 5 * 60 * 1000,
        defaultRedirectAfterLogin: '/dashboard',
        defaultRedirectAfterLogout: '/login',
        loginPath: '/login',
        dashboardPath: '/dashboard',
        
        // API key for device authentication        
        deviceApiKey: process.env.DEVICE_API_KEY || '3f7a9b25e8d146c0b2f15a6d90e74c8d',
        
        // WebRTC configuration
        webrtc: {
            iceServers: [
                { urls: process.env.STUN_SERVER || "stun:stun.l.google.com:19302" }
            ],
            useDataChannel: true,
            useAudio: false,
            useVideo: true
        },
        
        // Device monitoring configuration
        monitoring: {
            heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || "60000", 10), // 1 minute
            offlineThreshold: parseInt(process.env.OFFLINE_THRESHOLD || "300000", 10), // 5 minutes
            idleThreshold: parseInt(process.env.IDLE_THRESHOLD || "60000", 10) // 1 minute
        },
        
        // Data storage configuration
        storage: {
            dataDir: process.env.DATA_DIR || "./data",
            deviceDataDir: process.env.DEVICE_DATA_DIR || "./data/devices",
            deviceLogsDir: process.env.DEVICE_LOGS_DIR || "./data/logs",
            healthDataDir: process.env.HEALTH_DATA_DIR || "./data/health"
        }
    };
    
    // If running in browser, expose only client-side config
    if (typeof window !== 'undefined') {
        // Browser environment
        return {
            get: function(key) {
                const config = JSON.parse(localStorage.getItem(defaultConfig.configKey) || '{}');
                return key ? (config[key] || defaultConfig[key]) : { ...defaultConfig, ...config };
            },
            
            set: function(key, value) {
                const config = JSON.parse(localStorage.getItem(defaultConfig.configKey) || '{}');
                config[key] = value;
                localStorage.setItem(defaultConfig.configKey, JSON.stringify(config));
            },
            
            // Client-side constants
            apiUrl: defaultConfig.apiUrl,
            authTokenKey: defaultConfig.authTokenKey,
            userDataKey: defaultConfig.userDataKey,
            configKey: defaultConfig.configKey,
            tokenRefreshInterval: defaultConfig.tokenRefreshInterval,
            defaultRedirectAfterLogin: defaultConfig.defaultRedirectAfterLogin,
            defaultRedirectAfterLogout: defaultConfig.defaultRedirectAfterLogout,
            loginPath: defaultConfig.loginPath,
            dashboardPath: defaultConfig.dashboardPath,
            webrtc: defaultConfig.webrtc
        };
    } else {
        // Node.js environment
        return {
            ...defaultConfig,
            jwtSecret: process.env.JWT_SECRET || defaultConfig.jwtSecret,
            deviceApiKey: process.env.DEVICE_API_KEY || defaultConfig.deviceApiKey,
            port: process.env.PORT || 3000
        };
    }
})();

// Export the configuration
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AppConfig;
}