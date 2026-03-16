import { defineConfig } from 'vite'

export default defineConfig({
  // Alias react/react-dom to preact/compat so TanStack Query
  // and any other React-ecosystem packages work out of the box.
  resolve: {
    alias: {
      'react': 'preact/compat',
      'react-dom/test-utils': 'preact/test-utils',
      'react-dom': 'preact/compat',
      'react/jsx-runtime': 'preact/jsx-runtime',
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Root-level workspace management API.
      '/api/workspaces': {
        target: 'http://localhost:4000',
      },
      // Workspace-scoped API and data requests go to the Go server.
      // Matches: /{workspaceId}/api/... and /{workspaceId}/data/...
      // Exclude Vite internal paths (src, node_modules, @fs, @vite, @id).
      '^/(?!src/|node_modules/|@)[^/]+/api': {
        target: 'http://localhost:4000',
      },
      '^/(?!src/|node_modules/|@)[^/]+/data': {
        target: 'http://localhost:4000',
      },
    },
  },
})
