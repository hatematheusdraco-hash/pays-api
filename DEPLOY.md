# Deploying PayS (plain-language guide)

Goal: get a public link like `https://pays-api.onrender.com/dashboard` you can
open on your phone and show to anyone.

The code is already on GitHub (private repo). You deploy it on **Render** (free).
You only need to do the clicks below once — everything else is pre-configured.

## One-time setup on Render

1. Go to <https://render.com> and **Sign up with GitHub** (1 click, free, no card).
2. Click **New +** → **Blueprint**.
3. Choose the **`pays-api`** repository. Render reads `render.yaml` automatically.
4. It will ask for one secret value — **`DATABASE_URL`**. Paste the Supabase
   connection string (Session pooler):
   ```
   postgresql://postgres.desfroaqkhswcptwhtks:<DB_PASSWORD>@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
   ```
   (This is the same string from your local `.env`.)
5. Click **Apply / Create**. Render builds and deploys (~2–3 min).

## When it's live

Your links (replace the host with the one Render gives you):

- **Dashboard:** `https://<your-app>.onrender.com/dashboard`
- **API docs:** `https://<your-app>.onrender.com/docs`

To demo: open the dashboard → *Create test account* → *Create payment* →
*Open checkout* → pay with ETH → *Simulate* → watch it complete.

## Notes

- **Free plan sleeps** after ~15 min idle, so the first visit can take ~30–50s
  to wake up. For a smooth investor demo, open it once a minute before, or
  upgrade to the $7/mo plan for always-on.
- The database is your existing Supabase **PAYS** project — no new database is
  created. Demo payments accumulate there (harmless test data).
- Redeploys are automatic on every push to the GitHub repo's main branch.
