// React 19 needs the act() environment flag for jsdom component tests; without
// it every state update flushes outside act and timing-sensitive assertions
// race the React scheduler (the old sync-button-hide flake).
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
