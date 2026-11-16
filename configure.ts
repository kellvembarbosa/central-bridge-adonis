import { fileURLToPath } from 'node:url'
import type Configure from '@adonisjs/core/commands/configure'

/** Folder holding the `.stub` templates (copied to build/stubs). */
export const stubsRoot = fileURLToPath(new URL('./stubs/', import.meta.url))

/**
 * `node ace add @central/bridge-adonis` / `node ace configure @central/bridge-adonis`
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods()

  await codemods.makeUsingStub(stubsRoot, 'config/central_bridge.stub', {})
  await codemods.makeUsingStub(stubsRoot, 'services/central_bridge_handlers.stub', {})

  await codemods.defineEnvVariables({
    CENTRAL_BRIDGE_ENABLED: 'false',
    CENTRAL_BRIDGE_TOKEN: '',
    CENTRAL_BRIDGE_PRODUCT: '',
    CENTRAL_BRIDGE_ALLOWED_IPS: '',
    CENTRAL_URL: '',
  })

  await codemods.defineEnvValidations({
    leadingComment: 'Variables for configuring @central/bridge-adonis',
    variables: {
      CENTRAL_BRIDGE_ENABLED: 'Env.schema.boolean.optional()',
      CENTRAL_BRIDGE_TOKEN: 'Env.schema.string.optional()',
      CENTRAL_BRIDGE_PRODUCT: 'Env.schema.string.optional()',
      CENTRAL_BRIDGE_ALLOWED_IPS: 'Env.schema.string.optional()',
      CENTRAL_URL: 'Env.schema.string.optional()',
    },
  })

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@central/bridge-adonis/provider')
  })

  command.logger.info(
    'Libere /central-api/* do CSRF em config/shield.ts (csrf.exceptRoutes) e implemente app/services/central_bridge_handlers.ts.'
  )
}
