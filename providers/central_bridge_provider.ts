import type { ApplicationService } from '@adonisjs/core/types'
import { registerCentralBridgeRoutes } from '../src/routes.ts'
import type { CentralBridgeConfig } from '../src/types.ts'

/**
 * Reads `config/central_bridge.ts` and registers the Bridge routes.
 */
export default class CentralBridgeProvider {
  app: ApplicationService

  constructor(app: ApplicationService) {
    this.app = app
  }

  async boot() {
    const config = this.app.config.get<CentralBridgeConfig | undefined>('central_bridge')
    if (!config) return
    const router = await this.app.container.make('router')
    registerCentralBridgeRoutes(router, config)
  }
}
