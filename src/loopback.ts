// Local development servers rarely serve TLS, so these addresses open over plain HTTP.
export const LOOPBACK_ADDRESS = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
