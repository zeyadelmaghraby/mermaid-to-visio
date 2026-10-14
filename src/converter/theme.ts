export const referenceTheme = {
  name: 'Parallel', index: 40, font: 'Calibri',
  headerFill: '#5B9BD5', headerText: '#FFFFFF', headerWidth: 1.125, headerHeight: 0.525,
  headerPoints: 8, messagePoints: 6, branchPoints: 8, lineWeight: 0.5 / 72,
  messageLine: '#316176', lifeline: '#5B9BD5', frameLine: '#A5A5A5', divider: '#4271C6',
  activationFill: '#D6E6EE', activationLine: '#42829E', activationWidth: 0.125,
  success: '#00B050', failure: '#EE0000', text: '#000000',
  firstParticipantX: 1.40625, firstParticipantGap: 1.9375, participantGap: 2.0625,
  selfLoopWidth: 0.25, selfLoopDrop: 0.25, minimumFrameWidth: 3.25,
  actorWidth: 0.25, actorHeight: 0.5,
  actorBody: [[0.2, 0], [0.2, 0.5], [0.2, 0.3], [0, 0.3], [0, 0.7], [0.1, 0.75],
    [0.9, 0.75], [1, 0.7], [1, 0.3], [0.8, 0.3], [0.8, 0.5], [0.8, 0],
    [0.5, 0], [0.5, 0.4], [0.5, 0], [0.2, 0]],
} as const

export const pageSettings: Record<string, number> = {
  PageWidth: 21.5, PageHeight: 24.5, PageScale: 1, DrawingScale: 1,
  DrawingSizeType: 0, DrawingScaleType: 0, DrawingResizeType: 1,
  InhibitSnap: 0, UIVisibility: 0, PageLockReplace: 0, PageLockDuplicate: 0,
  PlaceStyle: 0, PlaceDepth: 0, PlowCode: 0, ResizePage: 0, DynamicsOff: 0,
  EnableGrid: 0, CtrlAsInput: 0, LineAdjustFrom: 0, PlaceFlip: 0, AvoidPageBreaks: 0,
  BlockSizeX: 0.25, BlockSizeY: 0.25, AvenueSizeX: 1, AvenueSizeY: 1, RouteStyle: 2,
  PageLineJumpDirX: 0, PageLineJumpDirY: 0, LineAdjustTo: 0, LineRouteExt: 0,
  LineToNodeX: 0.125, LineToNodeY: 0.125, LineToLineX: 0.125, LineToLineY: 0.125,
  LineJumpFactorX: 2 / 3, LineJumpFactorY: 2 / 3, LineJumpCode: 1, LineJumpStyle: 0, PageShapeSplit: 1,
  XRulerOrigin: 0, YRulerOrigin: 16, XGridOrigin: 0, YGridOrigin: 16,
  XGridSpacing: 0, YGridSpacing: 0, XRulerDensity: 32, YRulerDensity: 32, XGridDensity: 8, YGridDensity: 8,
  PageLeftMargin: 0.25, PageRightMargin: 0.25, PageTopMargin: 0.25, PageBottomMargin: 0.25,
  ScaleX: 1, ScaleY: 1, PagesX: 1, PagesY: 1, CenterX: 0, CenterY: 0, OnPage: 0,
  PrintGrid: 0, PrintPageOrientation: 2, PaperKind: 1, PaperSource: 7,
  ConnectorSchemeIndex: 40, EffectSchemeIndex: 40, ColorSchemeIndex: 40, FontSchemeIndex: 40,
  ThemeIndex: 40, VariationColorIndex: 0, VariationStyleIndex: 0, EmbellishmentIndex: 0,
}

export const connectorLayer = { Name: 'Connector', Visible: 1, Print: 1, Active: 0, Lock: 0, Snap: 1, Glue: 1, Color: 255, ColorTrans: 0 }

export function semanticColor(text: string): string {
  const negative = /\b(?:fail|failed|failure|error)\b|\bnot\s+exists\b/i.test(text)
  const positive = /\b(?:success|succeeded|exists)\b/i.test(text.replace(/\bnot\s+exists\b/gi, ''))
  return negative === positive ? referenceTheme.text : negative ? referenceTheme.failure : positive ? referenceTheme.success : referenceTheme.text
}