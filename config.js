// Settings for the Setter Center page. Nothing in this file is secret: the endpoint URL
// is public by design, and the team password (never stored here) is what protects the data.

// The Apps Script web app. After a redeploy with "New version" this URL stays the same.
export const ENDPOINT_URL = 'https://script.google.com/macros/s/AKfycbxvctVN4LZowqmuzdwzsISjLd8zqcUxih52PfYCPAf_XeSJvYXqy8JPOFfQv6ObWubfhQ/exec';

// Dials per setter per day. Set to null to hide the target tick everywhere.
export const DIAL_TARGET = 60;

// Link to the separate Ads Center dashboard in the header. Hidden while empty.
export const ADS_CENTER_URL = '';

// Polling interval, with +/-15% jitter. Polling pauses while the tab is hidden.
export const REFRESH_MS = 60000;
