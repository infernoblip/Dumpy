/* Public settings for the website. Every value here is meant to be public: it
   ships inside every page. Access control lives in the database rules
   (supabase/migrations), never here. Never put a secret or service-role key
   in this file. */
window.DUMPY_CONFIG = {
  supabaseUrl: "https://sfezmqsdzwrjdcqpyhln.supabase.co",
  supabaseKey: "sb_publishable_5V49nQQ2FYSsdRDt8kR6iQ_688LWupD",
  // The live address. The poster's QR code points here, and visit stats are
  // only counted on this host (not on previews or localhost).
  siteUrl: "https://dumpy.infernicustrap.workers.dev/",
  // Cloudflare Web Analytics site token (public; no cookies). Empty = off.
  // How to get it: docs/stage-11-setup.md.
  analyticsToken: "d1b5889dbf7d4446b89cf8200514c17e"
};
