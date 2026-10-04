export type Page = 'home' | 'chat' | 'games' | 'progression' | 'wallet' | 'profile'
export type GameKey = 'tictactoe' | 'sudoku' | 'ball-run' | 'water-sort'
export type ChatMode = 'chat' | 'vision' | 'image' | 'speech'
export type ChatMediaKind = 'image_input' | 'image_output' | 'audio_output'
export type ChatMedia = { path: string; kind: ChatMediaKind }
export type ChatAttachment = { path: string; name: string; mimeType: string; size: number }
export type ChatMessage = {
  id: string
  role: 'nova' | 'you'
  text: string
  created_at: string
  media?: ChatMedia | null
}
export type Conversation = {
  id: string
  title: string
  created_at: string
  last_message_at: string
}
export type Toast = { id: number; kind: 'success' | 'error'; text: string }
export type Outcome = 'win' | 'loss' | 'draw'

export type ProfileData = { display_name: string; level: number; xp: number; streak: number }
export type GameProgress = { games_played: number; games_won: number; best_score: number | null; total_xp: number }
export type GameResult = { id: string; outcome: string; created_at: string }
export type WalletTransaction = {
  id: string
  type: string
  amount: number
  currency: string
  source: string | null
  created_at: string
}
export type ProfileState = {
  profile: ProfileData | null
  progress: GameProgress | null
  sudokuProgress: GameProgress | null
  ballProgress: GameProgress | null
  waterProgress: GameProgress | null
  recentResults: GameResult[]
  achievements: AchievementView[]
  loading: boolean
  error: string | null
}

export type AchievementCatalog = {
  id: string
  name: string
  description: string
  category: string
  icon: string | null
}

export type AchievementView = AchievementCatalog & {
  earned: boolean
  earned_at: string | null
}

export type LeaderboardRow = {
  rank: number
  display_name: string
  xp: number
  level: number
  is_me: boolean
}

// One-time hand-off from a completed game to Chat. Carries only a reference to
// the player's own completed session — rewards are never carried client-side.
export type PostGameContext = { sessionId: string; game: 'tictactoe' | 'sudoku' } | { sessionId: string; game: 'ball-run' | 'water-sort' }
