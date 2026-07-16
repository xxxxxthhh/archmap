import { introPath } from '../content.js';
import { loadPage } from '../db/connection.js';

export const renderPage = (): string => `${loadPage()}: ${introPath}`;
