export type SoundKind = 'roll' | 'move' | 'hit' | 'cube' | 'turn' | 'win'

const STORAGE_KEY = 'nard_muted'
let context: AudioContext | null = null
let muted = readMuted()

function readMuted(): boolean {
  try { return window.localStorage.getItem(STORAGE_KEY) === '1' }
  catch { return false }
}

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    context ??= new Ctor()
    if (context.state === 'suspended') void context.resume().catch(() => {})
    return context
  } catch {
    return null
  }
}

function tone(ctx: AudioContext, start: number, duration: number, fromHz: number, toHz: number, gainPeak: number, type: OscillatorType = 'triangle'): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(fromHz, start)
  if (toHz !== fromHz) osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), start + duration)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.linearRampToValueAtTime(gainPeak, start + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(start)
  osc.stop(start + duration + 0.01)
}

function diceClick(ctx: AudioContext, start: number, gainPeak: number, filterHz: number): void {
  const length = Math.max(1, Math.floor(ctx.sampleRate * 0.028))
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const filter = ctx.createBiquadFilter()
  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(filterHz, start)
  filter.Q.setValueAtTime(2.2, start)
  const gain = ctx.createGain()
  gain.gain.setValueAtTime(gainPeak, start)
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.028)
  source.connect(filter)
  filter.connect(gain)
  gain.connect(ctx.destination)
  source.start(start)
}

export function isSoundMuted(): boolean {
  return muted
}

export function toggleSoundMuted(): boolean {
  muted = !muted
  try { window.localStorage.setItem(STORAGE_KEY, muted ? '1' : '0') } catch {}
  if (!muted) playSound('move')
  return muted
}

export function playSound(kind: SoundKind): void {
  if (muted) return
  const ctx = getContext()
  if (!ctx) return
  const now = ctx.currentTime
  try {
    if (kind === 'roll') {
      diceClick(ctx, now, 0.08, 1200)
      diceClick(ctx, now + 0.055, 0.07, 1550)
      diceClick(ctx, now + 0.12, 0.09, 1050)
      diceClick(ctx, now + 0.185, 0.06, 1380)
    } else if (kind === 'move') {
      tone(ctx, now, 0.055, 240, 96, 0.09, 'triangle')
    } else if (kind === 'hit') {
      tone(ctx, now, 0.05, 340, 125, 0.11, 'triangle')
      tone(ctx, now + 0.045, 0.075, 190, 68, 0.1, 'sine')
    } else if (kind === 'cube') {
      tone(ctx, now, 0.12, 440, 440, 0.06, 'sine')
      tone(ctx, now + 0.085, 0.16, 659, 659, 0.06, 'sine')
    } else if (kind === 'turn') {
      tone(ctx, now, 0.11, 523, 523, 0.045, 'sine')
    } else if (kind === 'win') {
      tone(ctx, now, 0.14, 523, 523, 0.07, 'sine')
      tone(ctx, now + 0.11, 0.14, 659, 659, 0.07, 'sine')
      tone(ctx, now + 0.22, 0.28, 784, 784, 0.08, 'sine')
    }
  } catch {}
}
