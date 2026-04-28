// server.js
import express from 'express';

const app = express();

app.use(express.static('.'));

app.get('/api/shopify-token', (req, res) => {
  res.json({ token: process.env.SHOPIFY_ADMIN_API_TOKEN || '' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on ${port}`));