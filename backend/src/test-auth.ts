// Test script for service authentication
import { getServiceAuthenticator, getSecretsAuthenticator, getKagAuthenticator, getLicensesAuthenticator } from './lib/service-authenticators';

async function testAuth() {
  console.log('Testing OAuth2 Service Authentication...');

  try {
    // Test getting authenticator instances
    console.log('1. Getting authenticator instances...');
    const serviceAuth = getServiceAuthenticator();
    const secretsAuth = getSecretsAuthenticator();
    const kagAuth = getKagAuthenticator();
    const licensesAuth = getLicensesAuthenticator();
    console.log('All authenticators created successfully');

    // Test getting access token
    console.log('2. Fetching access token...');
    const token = await serviceAuth.getAccessToken();
    console.log('Access token obtained');

    // Check token info
    const tokenInfo = serviceAuth.getTokenInfo();
    if (tokenInfo) {
      console.log('3. Token information:');
      console.log('   Expires in: ' + tokenInfo.expiresIn + ' seconds');
    }

    // Test getting auth header
    console.log('4. Getting auth header...');
    const authHeader = await serviceAuth.getAuthHeader();
    console.log('Auth header obtained');

    console.log('All tests passed!');
    
  } catch (error) {
    console.error('Authentication test failed:', error);
    process.exit(1);
  }
}

testAuth();
