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
        jwtSecret: process.env.JWT_SECRET || "wynzio-development-secret",
        tokenRefreshInterval: 5 * 60 * 1000, // 5 minutes in milliseconds
        defaultRedirectAfterLogin: '/dashboard',
        defaultRedirectAfterLogout: '/login',
        loginPath: '/login',
        dashboardPath: '/dashboard'
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
            dashboardPath: defaultConfig.dashboardPath
        };
    } else {
        // Node.js environment
        return {
            ...defaultConfig,
            jwtSecret: process.env.JWT_SECRET || defaultConfig.jwtSecret,
            port: process.env.PORT || 3000
        };
    }
})();

// Export the configuration
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AppConfig;
}