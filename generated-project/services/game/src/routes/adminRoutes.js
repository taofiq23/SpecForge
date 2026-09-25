'use strict';

/**
 * Backwards-compatible shim.
 *
 * AdminComponent used to live here as an inline router hosted by GameComponent.
 * It is now a real module at services/admin/src/*, mirroring
 * GameComponent/QuestionComponent/UserComponent, and GameComponent mounts it via
 * `AdminComponent.mountOn(app)`.
 *
 * This file is kept so existing imports (including the test suite and any
 * external caller) keep resolving to the same symbols.
 *
 * See:
 *   services/admin/src/component.js       (the AdminComponent class)
 *   services/admin/src/routes/adminRoutes.js
 *   services/admin/src/service/adminService.js
 */
const {
  createAdminRoutes,
  ADMIN_BASE_PATH,
} = require('../../../admin/src/routes/adminRoutes');

module.exports = { createAdminRoutes, ADMIN_BASE_PATH };
