/**
 * broker-routes/index.ts
 *
 * Barrel router for the Paw Broker domain. Mounts each per-concern
 * sub-router at the root so the absolute /api/v1/broker/... paths declared
 * inside each module are byte-for-byte stable.
 *
 * Sub-routers:
 *   - properties      -- list, get, edit anchor properties
 *   - deals           -- list + status transitions for sourced deals
 *   - portfolio       -- portfolio rollup + str bookings rollup
 *   - rehab           -- rehab estimates, contractors, improvements, comps
 *   - tax             -- tax clock, cost-seg studies, tax abatements
 *   - participation   -- IRS-audit-defense participation log + totals
 *   - father-broker   -- off-market listings inbox + status transitions
 *   - investments     -- non-RE asset CRUD (manual entry only)
 */

import { Router } from 'express'
import propertiesRoutes from './properties.js'
import dealsRoutes from './deals.js'
import portfolioRoutes from './portfolio.js'
import rehabRoutes from './rehab.js'
import taxRoutes from './tax.js'
import participationRoutes from './participation.js'
import fatherBrokerRoutes from './father-broker.js'
import investmentsRoutes from './investments.js'

const router = Router()

router.use(propertiesRoutes)
router.use(dealsRoutes)
router.use(portfolioRoutes)
router.use(rehabRoutes)
router.use(taxRoutes)
router.use(participationRoutes)
router.use(fatherBrokerRoutes)
router.use(investmentsRoutes)

export default router
