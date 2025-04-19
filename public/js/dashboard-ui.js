/**
 * dashboard-ui.js
 * Handles general dashboard UI elements like sidebar, navigation, and user dropdown
 */

document.addEventListener('DOMContentLoaded', async function() {
    try {
        // Protect page - redirect to login if not authenticated
        const isAuthenticated = await Auth.protectPage();
        
        if (!isAuthenticated) {
            // If not authenticated, stop execution
            return;
        }
        
        // Initialize dashboard
        await App.init();
        
        // Initialize navigation
        initNavigation();
        
    } catch (error) {
        console.error('Dashboard UI initialization error:', error);
        // Redirect to login on critical error
        window.location.href = '/login';
    }
});

/**
 * Initialize navigation
 */
function initNavigation() {
    const sidebar = document.getElementById('sidebar');
    const mainContent = document.getElementById('main-content');
    const mobileNavToggle = document.getElementById('mobile-nav-toggle');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const hamburgerIcon = document.getElementById('hamburger-icon');
    
    // Initialize user dropdown
    initUserDropdown();
    
    // Check if we're on mobile
    function isMobile() {
        return window.innerWidth <= 768;
    }
    
    // Set initial state based on screen size
    function setInitialState() {
        if (isMobile()) {
            sidebar.classList.remove('visible');
            mainContent.classList.remove('shifted');
        } else {
            // Desktop: sidebar is visible by default
            sidebar.classList.remove('sidebar-collapsed');
            mainContent.classList.remove('expanded');
            hamburgerIcon.classList.remove('open');
        }
    }
    
    // Toggle sidebar visibility
    function toggleSidebar() {
        if (isMobile()) {
            // Mobile behavior
            sidebar.classList.toggle('visible');
            mainContent.classList.toggle('shifted');
            sidebarOverlay.classList.toggle('visible');
        } else {
            // Desktop behavior
            sidebar.classList.toggle('sidebar-collapsed');
            mainContent.classList.toggle('expanded');
        }
        
        // Toggle hamburger/X icon
        hamburgerIcon.classList.toggle('open');
    }
    
    // Set initial state
    setInitialState();
    
    // Toggle sidebar on hamburger menu click
    if (mobileNavToggle) {
        mobileNavToggle.addEventListener('click', toggleSidebar);
    }
    
    // Close sidebar when clicking outside on mobile
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', function() {
            if (sidebar.classList.contains('visible')) {
                toggleSidebar();
            }
        });
    }
    
    // Handle window resize
    window.addEventListener('resize', function() {
        setInitialState();
    });
    
    // Add click handler for menu items
    const menuItems = document.querySelectorAll('.menu-item');
    if (menuItems) {
        menuItems.forEach(item => {
            item.addEventListener('click', function() {
                // Remove active class from all items
                menuItems.forEach(i => i.classList.remove('active'));
                
                // Add active class to clicked item
                this.classList.add('active');
                
                // Update page title
                const page = this.getAttribute('data-page');
                const pageTitle = document.getElementById('page-title');
                
                if (pageTitle) {
                    pageTitle.textContent = this.getAttribute('data-title') || 
                        page.charAt(0).toUpperCase() + page.slice(1);
                }
                
                // For mobile, close sidebar after selection
                if (isMobile() && sidebar.classList.contains('visible')) {
                    toggleSidebar();
                }
                
                // Go back to device list if in remote viewer
                if (document.getElementById('remote-viewer-section').classList.contains('active')) {
                    if (typeof disconnectFromDevice === 'function') {
                        disconnectFromDevice();
                    }
                    if (typeof showDeviceListSection === 'function') {
                        showDeviceListSection();
                    }
                }
            });
        });
    }
    
    // Add notification style if not already added
    if (typeof Utils !== 'undefined' && Utils.addCSS) {
        Utils.addCSS(`
            .notification-container {
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 9999;
                max-width: 350px;
            }
            
            .notification {
                display: flex;
                align-items: center;
                padding: 15px;
                margin-bottom: 10px;
                background-color: white;
                border-radius: 5px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                transform: translateX(400px);
                opacity: 0;
                transition: all 0.3s ease;
            }
            
            .notification-visible {
                transform: translateX(0);
                opacity: 1;
            }
            
            .notification-closing {
                transform: translateX(400px);
                opacity: 0;
            }
            
            .notification-icon {
                margin-right: 15px;
                font-size: 1.2rem;
            }
            
            .notification-content {
                flex: 1;
            }
            
            .notification-close {
                background: none;
                border: none;
                font-size: 1rem;
                cursor: pointer;
                opacity: 0.5;
                transition: opacity 0.3s ease;
            }
            
            .notification-close:hover {
                opacity: 1;
            }
            
            .notification-success .notification-icon {
                color: var(--success-color);
            }
            
            .notification-error .notification-icon {
                color: var(--danger-color);
            }
            
            .notification-warning .notification-icon {
                color: var(--warning-color);
            }
            
            .notification-info .notification-icon {
                color: var(--info-color);
            }
        `, 'notification-styles');
        
        // Add dashboard section styles
        Utils.addCSS(`
            .dashboard-section {
                display: none;
            }
            
            .dashboard-section.active {
                display: block;
            }
        `, 'dashboard-section-styles');
    }
}

/**
 * Initialize user dropdown
 */
function initUserDropdown() {
    const userDropdown = document.getElementById('user-dropdown');
    const userDropdownMenu = document.getElementById('user-dropdown-menu');
    
    if (userDropdown && userDropdownMenu) {
        // Clear any existing event listeners
        userDropdown.replaceWith(userDropdown.cloneNode(true));
        
        // Get the fresh reference
        const refreshedUserDropdown = document.getElementById('user-dropdown');
        
        // Add click event listener with stopPropagation
        refreshedUserDropdown.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            userDropdownMenu.classList.toggle('show');
        });
        
        // Add click handler for each dropdown item
        const dropdownItems = userDropdownMenu.querySelectorAll('.dropdown-item');
        dropdownItems.forEach(item => {
            item.addEventListener('click', function(e) {
                e.stopPropagation(); // Prevent event bubbling
                const itemId = this.id;
                
                if (itemId === 'refresh-data-btn') {
                    e.preventDefault();
                    if (typeof App !== 'undefined' && App.refreshData) {
                        App.refreshData(true);
                    }
                    userDropdownMenu.classList.remove('show');
                } else if (itemId === 'dropdown-logout-btn') {
                    e.preventDefault();
                    if (typeof Auth !== 'undefined' && Auth.handleLogout) {
                        Auth.handleLogout();
                    }
                } else if (itemId === 'profile-btn') {
                    e.preventDefault();
                    // Handle profile view
                    userDropdownMenu.classList.remove('show');
                } else if (itemId === 'account-settings-btn') {
                    e.preventDefault();
                    // Handle account settings
                    userDropdownMenu.classList.remove('show');
                }
            });
        });
    }
    
    // Close dropdown when clicking outside
    document.addEventListener('click', function(e) {
        if (userDropdownMenu && userDropdownMenu.classList.contains('show') && 
            !userDropdown.contains(e.target)) {
            userDropdownMenu.classList.remove('show');
        }
    });
}