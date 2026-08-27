import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { handleTangoApi } from './server/tangoProxy.ts'

function tangoApi(): Plugin {
  const attach = (server: { middlewares: { use: Function } }) => {
    server.middlewares.use(async (req: unknown, res: unknown, next: (err?: unknown) => void) => {
      try {
        const handled = await handleTangoApi(req as never, res as never)
        if (!handled) next()
      } catch (err) {
        next(err)
      }
    })
  }
  return {
    name: 'tango-api',
    configureServer(server) {
      attach(server)
    },
    configurePreviewServer(server) {
      attach(server)
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  Object.assign(process.env, env)
  return {
    plugins: [react(), tangoApi()],
    server: {
      host: true,
      port: 5173,
      allowedHosts: true,
      hmr: false,
      watch: {
        ignored: ['**/tools/**'],
      },
    },
    preview: {
      host: true,
      port: 4173,
      allowedHosts: true,
    },
  }
})
