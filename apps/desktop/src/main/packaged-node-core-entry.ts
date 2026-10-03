import { installPackagedRouteCoreObserver } from './packaged-route-core-observer.js'
import { runDesktopCoreHost } from './core-host.js'

const hooks = installPackagedRouteCoreObserver('node')
void runDesktopCoreHost({ dependencies: hooks.dependencies })
