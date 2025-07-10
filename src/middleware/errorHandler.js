const { setupLogger } = require('../utils/logger');
const logger = setupLogger();

const errorHandler = (err, req, res, next) => {
    logger.error('Error:', {
        message: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
    });

    res.status(err.status || 500).json({
        error: {
            message: process.env.NODE_ENV === 'production' 
                ? 'An unexpected error occurred' 
                : err.message
        }
    });
};

module.exports = { errorHandler };
