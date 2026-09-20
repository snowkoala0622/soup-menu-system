const express = require('express');
const cors = require('cors');
const path = require('path');
const dishesRouter = require('./routes/dishes');
const categoriesRouter = require('./routes/categories');
const membersRouter = require('./routes/members');
const ordersRouter = require('./routes/orders');
const facialRouter = require('./routes/facial');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/dishes', dishesRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/members', membersRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/facial-analysis', facialRouter); 

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});