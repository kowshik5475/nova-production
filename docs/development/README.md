# Development

NOVA AI Play development guides, setup, and operational guidelines.

## Setup

```bash
npm install
npm run dev
```

## Build

```bash
npm run build     # tsc -b && vite build
npm run preview   # preview the build locally
```

## Testing

```bash
npm run lint      # oxlint
npm run build     # type check + build
node --experimental-strip-types supabase/tests/<file>.test.ts
```

Full test suite: 17 files, 322 tests. Run against a live Supabase project configured in `.env`.

## Edge Functions

```bash
supabase functions deploy process-tictactoe
supabase functions deploy process-sudoku
supabase functions deploy process-ball-run
supabase functions deploy process-water-sort
supabase functions deploy nova-chat
supabase functions deploy exchange-nova-coins
supabase functions deploy delete-account
```

## Environment Variables

Create `.env` in project root:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Both are optional. If omitted, NOVA runs in demo mode.

## Demo Mode

When `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are not set, NOVA enters demo mode with session-local balances.