import express from 'express';
import { requireModuleAccess } from './superadmin/middleware.js';
import usersRouter from './superadmin/users.js';
import sipConfigRouter from './superadmin/sip-config.js';
import routingRouter from './superadmin/routing.js';
import pbxFeaturesRouter from './superadmin/pbx-features.js';
import liveMonitoringRouter from './superadmin/live-monitoring.js';
import cdrReportsRouter from './superadmin/cdr-reports.js';
import settingsRouter from './superadmin/settings.js';
import uploadRouter from './superadmin/upload.js';

const router = express.Router();

router.use(requireModuleAccess);

router.use(uploadRouter);
router.use(usersRouter);
router.use(sipConfigRouter);
router.use(routingRouter);
router.use(pbxFeaturesRouter);
router.use(liveMonitoringRouter);
router.use(cdrReportsRouter);
router.use(settingsRouter);

export default router;
