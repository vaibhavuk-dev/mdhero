// Ambient declarations for markdown-it plugins that ship no types.
//
// Both are used as `md.use(plugin, options)`; markdown-it's `use` accepts a
// loosely-typed PluginWithOptions, so `any` here is what the call site already
// gets — this only tells the compiler the modules exist.
declare module "markdown-it-task-lists";
declare module "markdown-it-texmath";
