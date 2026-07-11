# Blog card templates

Deterministic Playwright renders for blog featured + OG images.
Copy an existing card HTML, edit the copy for the new post, point the render script at it.
Outputs: public/blog-<slug>.webp (1000x662) + public/blog-<slug>-og.jpg (1200x630).
Run: node scripts/blog-cards/render-amen-cards.cjs
