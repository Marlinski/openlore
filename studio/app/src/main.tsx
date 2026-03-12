import { render } from 'preact'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
})

render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
  document.getElementById('app')!,
)
