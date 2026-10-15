export const WORKING = ['⠇', '⠋', '⠙', '⠸', '⢰', '⣠', '⣄', '⡆']

export const WAITING = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']

export const dotsOf = (glyph: string) =>
  ((glyph.codePointAt(0) ?? 0x2800) - 0x2800).toString(2).split('').filter(bit => bit === '1').length

export const frameOf = (glyphs: readonly string[], frame: number, framesPerStep = 1) =>
  glyphs[Math.floor(frame / framesPerStep) % glyphs.length] ?? glyphs[0] ?? ' '
