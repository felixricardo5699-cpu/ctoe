// React 19 refuses to run act() unless the environment opts in explicitly.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

export {}
