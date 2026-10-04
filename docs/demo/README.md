# Demo Mode

NOVA AI Play runs entirely in-browser with no Supabase connection when environment variables are not set.

## Demo Mode Features

- No authentication required
- All games work locally with the same logic
- Starting balance: 20 NOVA Coins, 0 AI Credits
- Exchange works locally (10 coins → 1 credit)
- Chat shows a canned response (no Gemini call)
- Balances reset on page refresh
- A "DEMO" badge appears in the top bar

## When to Use Demo Mode

- No Supabase project configured
- Testing UI flows without credentials
- Offline development
- Evaluator walkthroughs

## Configuration

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env` to disable demo mode and connect to a Supabase project.