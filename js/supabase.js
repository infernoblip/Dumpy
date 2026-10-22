/* The one shared Supabase client. Every page loads, in order:
   the pinned supabase-js from the CDN, js/config.js, then this file. */
(function () {
  var cfg = window.DUMPY_CONFIG;
  window.Dumpy = window.Dumpy || {};
  if (!window.supabase || !window.supabase.createClient) {
    window.Dumpy.db = null; // js/auth.js shows a "could not load" message
    return;
  }
  window.Dumpy.db = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: {
      // Magic links come back with the session in the address (#access_token=...).
      // "implicit" lets the link work even when the email app opens it in a
      // different browser from the one that asked for it.
      flowType: "implicit",
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true
    }
  });
})();
