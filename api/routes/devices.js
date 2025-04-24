/**
 * Device API routes
 * Updated to use remotePcId consistently with Windows app
 */
const express = require('express');
const router = express.Router();
const deviceController = require('../controllers/deviceController');
const authMiddleware = require('../middleware/auth');
const rbacMiddleware = require('../middleware/rbac');

/**
 * @route POST /api/devices/register
 * @desc Register a device
 * @access Public (with API key)
 */
router.post('/register', deviceController.registerDevice);

/**
 * @route GET /api/devices
 * @desc Get all devices
 * @access Private (admin, guest)
 */
router.get('/', 
  authMiddleware, 
  rbacMiddleware(['admin', 'guest'], ['view:devices']), 
  deviceController.getAllDevices
);

/**
 * @route GET /api/devices/online
 * @desc Get online devices
 * @access Private
 */
router.get('/online', 
  authMiddleware, 
  rbacMiddleware([], ['view:devices']), 
  deviceController.getOnlineDevices
);

/**
 * @route GET /api/devices/:remotePcId
 * @desc Get device by remotePcId
 * @access Private
 */
router.get('/:remotePcId', 
  authMiddleware, 
  rbacMiddleware([], ['view:devices']), 
  deviceController.getDeviceById
);

/**
 * @route GET /api/devices/:remotePcId/health
 * @desc Get device health
 * @access Private
 */
router.get('/:remotePcId/health', 
  authMiddleware, 
  rbacMiddleware([], ['view:devices']), 
  deviceController.getDeviceHealth
);

/**
 * @route GET /api/devices/:remotePcId/logs
 * @desc Get device logs
 * @access Private (admin)
 */
router.get('/:remotePcId/logs', 
  authMiddleware, 
  rbacMiddleware(['admin'], ['view:logs']), 
  deviceController.getDeviceLogs
);

/**
 * @route POST /api/devices/:remotePcId/connect
 * @desc Initiate connection to device
 * @access Private
 */
router.post('/:remotePcId/connect', 
  authMiddleware, 
  rbacMiddleware([], ['control:devices']), 
  deviceController.initiateConnection
);

/**
 * @route GET /api/devices/system/health
 * @desc Get system health overview
 * @access Private (admin, guest)
 */
router.get('/system/health', 
  authMiddleware, 
  rbacMiddleware(['admin', 'guest'], ['view:settings']), 
  deviceController.getSystemHealth
);

module.exports = router;