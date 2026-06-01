"""
Saxo Bank OpenAPI Authorization Token Script
PKCE (Proof Key for Code Exchange) Flow Implementation
"""

import hashlib
import base64
import secrets
import webbrowser
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
import requests
import json


class SaxoAuthConfig:
    """Configuration for Saxo Bank OpenAPI Authorization"""
    def __init__(self, app_key, app_url, auth_url, redirect_port=8080):
        self.app_key = app_key
        self.app_url = app_url
        self.auth_url = auth_url
        self.redirect_port = redirect_port
        self.redirect_uri = f"{app_url}:{redirect_port}"
        self.authorization_endpoint = f"{auth_url}/authorize"
        self.token_endpoint = f"{auth_url}/token"


class AuthCallbackHandler(BaseHTTPRequestHandler):
    """Handler for OAuth callback"""
    authorization_code = None
    state_received = None
    
    def do_GET(self):
        # Parse the query parameters
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)
        
        # Extract authorization code and state
        AuthCallbackHandler.authorization_code = params.get('code', [None])[0]
        AuthCallbackHandler.state_received = params.get('state', [None])[0]
        
        # Send response to browser
        self.send_response(200)
        self.send_header('Content-type', 'text/html')
        self.end_headers()
        
        if AuthCallbackHandler.authorization_code:
            message = """
            <html>
            <body>
                <h1>Authorization Successful!</h1>
                <p>You can close this window and return to your application.</p>
            </body>
            </html>
            """
        else:
            message = """
            <html>
            <body>
                <h1>Authorization Failed!</h1>
                <p>No authorization code received.</p>
            </body>
            </html>
            """
        
        self.wfile.write(message.encode())
    
    def log_message(self, format, *args):
        # Suppress server log messages
        pass


def generate_code_verifier():
    """
    Generate a code verifier for PKCE.
    Returns a 43-character URL-safe string.
    """
    code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode('utf-8')
    # Remove padding characters
    return code_verifier.rstrip('=')


def generate_code_challenge(code_verifier):
    """
    Generate code challenge from code verifier using S256 method.
    code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
    """
    code_challenge = hashlib.sha256(code_verifier.encode('utf-8')).digest()
    code_challenge = base64.urlsafe_b64encode(code_challenge).decode('utf-8')
    # Remove padding characters
    return code_challenge.rstrip('=')


def generate_state():
    """Generate a random state parameter for CSRF protection"""
    return secrets.token_urlsafe(32)


def build_authorization_url(config, code_challenge, state):
    """Build the authorization URL with all required parameters"""
    params = {
        'response_type': 'code',
        'client_id': config.app_key,
        'state': state,
        'redirect_uri': config.redirect_uri,
        'code_challenge': code_challenge,
        'code_challenge_method': 'S256'
    }
    
    query_string = urllib.parse.urlencode(params)
    return f"{config.authorization_endpoint}?{query_string}"


def exchange_code_for_token(config, authorization_code, code_verifier):
    """
    Exchange authorization code for access token.
    """
    token_data = {
        'grant_type': 'authorization_code',
        'code': authorization_code,
        'redirect_uri': config.redirect_uri,
        'client_id': config.app_key,
        'code_verifier': code_verifier
    }
    
    headers = {
        'Content-Type': 'application/x-www-form-urlencoded'
    }
    
    try:
        response = requests.post(
            config.token_endpoint,
            data=token_data,
            headers=headers
        )
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error exchanging code for token: {e}")
        if hasattr(e.response, 'text'):
            print(f"Response: {e.response.text}")
        return None


def get_authorization_token(config):
    """
    Main function to orchestrate the PKCE authorization flow.
    Returns the token response containing access_token, refresh_token, etc.
    """
    print("=" * 60)
    print("Saxo Bank OpenAPI - Authorization Token Flow")
    print("=" * 60)
    
    # Step 1: Generate PKCE parameters
    print("\n[Step 1] Generating PKCE parameters...")
    code_verifier = generate_code_verifier()
    code_challenge = generate_code_challenge(code_verifier)
    state = generate_state()
    
    print(f"  ✓ Code Verifier: {code_verifier[:20]}...")
    print(f"  ✓ Code Challenge: {code_challenge[:20]}...")
    print(f"  ✓ State: {state[:20]}...")
    
    # Step 2: Build authorization URL
    print("\n[Step 2] Building authorization URL...")
    auth_url = build_authorization_url(config, code_challenge, state)
    print(f"  ✓ Authorization URL ready")
    
    # Step 3: Open browser for user authorization
    print("\n[Step 3] Opening browser for user authorization...")
    print(f"  → Please log in and authorize the application")
    webbrowser.open(auth_url)
    
    # Step 4: Start local server to receive callback
    print("\n[Step 4] Waiting for authorization callback...")
    print(f"  → Listening on {config.redirect_uri}")
    
    server = HTTPServer(('localhost', config.redirect_port), AuthCallbackHandler)
    server.handle_request()  # Handle one request and stop
    
    authorization_code = AuthCallbackHandler.authorization_code
    state_received = AuthCallbackHandler.state_received
    
    if not authorization_code:
        print("\n  ✗ Failed to receive authorization code")
        return None
    
    # Verify state
    if state != state_received:
        print("\n  ✗ State mismatch - possible CSRF attack")
        return None
    
    print(f"  ✓ Authorization code received: {authorization_code[:20]}...")
    
    # Step 5: Exchange code for token
    print("\n[Step 5] Exchanging authorization code for access token...")
    token_response = exchange_code_for_token(config, authorization_code, code_verifier)
    
    if token_response:
        print("  ✓ Access token received successfully!")
        print("\n" + "=" * 60)
        print("Token Details:")
        print("=" * 60)
        print(json.dumps(token_response, indent=2))
        print("=" * 60)
        return token_response
    else:
        print("  ✗ Failed to exchange code for token")
        return None


def main():
    """
    Main entry point - Configure your application details here.
    """
    # TODO: Update these values with your actual Saxo Bank OpenAPI credentials
    config = SaxoAuthConfig(
        app_key="YOUR_APP_KEY_HERE",           # Replace with your AppKey
        app_url="http://localhost",             # Your registered AppUrl (without port)
        auth_url="https://sim.logonvalidation.net",  # For simulation environment
        redirect_port=8080                      # Port for local callback server
    )
    
    # Validate configuration
    if config.app_key == "YOUR_APP_KEY_HERE":
        print("⚠️  Please update the configuration in the script with your actual credentials!")
        print("\nRequired values:")
        print("  - app_key: Your Saxo Bank AppKey")
        print("  - app_url: Your registered redirect URL (without port)")
        print("  - auth_url: Authentication URL (sim or production)")
        return
    
    # Run the authorization flow
    token_response = get_authorization_token(config)
    
    if token_response:
        # Save token to file for future use
        with open('token.json', 'w') as f:
            json.dump(token_response, f, indent=2)
        print("\n✓ Token saved to 'token.json'")
        
        # Display access token (first 50 chars for security)
        access_token = token_response.get('access_token', '')
        print(f"\nAccess Token: {access_token[:50]}...")
    else:
        print("\n✗ Authorization failed")


if __name__ == "__main__":
    main()
