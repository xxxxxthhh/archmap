import express from 'express';

const app = express();
app.get('/health', () => {});
app.post('/users', () => {});

export { app };
