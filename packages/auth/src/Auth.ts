/*
 * Copyright 2017-2017 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance with
 * the License. A copy of the License is located at
 *
 *     http://aws.amazon.com/apache2.0/
 *
 * or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions
 * and limitations under the License.
 */

import { AuthOptions, FederatedResponse, ConfirmSignUpOptions } from './types';

import {
    AWS,
    ConsoleLogger as Logger,
    Constants,
    Hub,
    JS,
    Parser,
    Credentials,
    StorageHelper
} from '@aws-amplify/core';
import Cache from '@aws-amplify/cache';
import {
    CookieStorage,
    CognitoUserPool,
    CognitoUserAttribute,
    CognitoUser,
    AuthenticationDetails,
    ICognitoUserPoolData,
    ICognitoUserData
} from 'amazon-cognito-identity-js';
import { CognitoAuth } from 'amazon-cognito-auth-js';

const logger = new Logger('AuthClass');
const dispatchAuthEvent = (event, data) => {
    Hub.dispatch('auth', { event, data }, 'Auth');
};

/**
* Provide authentication steps
*/
export default class AuthClass {
    private _config: AuthOptions;
    private _userPoolStorageSync: Promise<any>;
    private userPool = null;
    private _cognitoAuthClient = null;
    private user:any = null;

    private _gettingCredPromise = null;
    private _storage;
    private _storageSync;

    /**
     * Initialize Auth with AWS configurations
     * @param {Object} config - Configuration of the Auth
     */
    constructor(config: AuthOptions) {
        this.configure(config);

        this.currentUserCredentials = this.currentUserCredentials.bind(this);

        if (AWS.config) {
            AWS.config.update({customUserAgent: Constants.userAgent});
        } else {
            logger.warn('No AWS.config');
        }
    }

    public getModuleName() {
        return 'Auth';
    }

    configure(config) {
        if (!config) return this._config || {};
        logger.debug('configure Auth');
        const conf = Object.assign({}, this._config, Parser.parseMobilehubConfig(config).Auth, config);
        this._config = conf;
        const { 
            userPoolId, 
            userPoolWebClientId, 
            cookieStorage, 
            oauth, 
            region, 
            identityPoolId, 
            mandatorySignIn,
            refreshHandlers,
            storage,
            identityPoolRegion
        } = this._config;

        if (!this._config.storage) {
            // backward compatbility
            if (cookieStorage) this._storage = new CookieStorage(cookieStorage);
            else {
                this._storage = new StorageHelper().getStorage();
            }
        } else {
            this._storage = this._config.storage;
        }

        this._storageSync = Promise.resolve();
        if (typeof this._storage['sync'] === 'function') {
            this._storageSync = this._storage['sync']();
        }

        if (userPoolId) {
            const userPoolData: ICognitoUserPoolData = {
                UserPoolId: userPoolId,
                ClientId: userPoolWebClientId,
            };
            userPoolData.Storage = this._storage;
            
            this.userPool = new CognitoUserPool(userPoolData);
        }

        Credentials.configure({
            mandatorySignIn,
            region: identityPoolRegion || region,
            userPoolId,
            identityPoolId,
            refreshHandlers,
            storage: this._storage
        });

        // initiailize cognitoauth client if hosted ui options provided
        if (oauth) {
            const that = this;

            const cognitoAuthParams = Object.assign(
                {
                    ClientId: userPoolWebClientId,
                    UserPoolId: userPoolId,
                    AppWebDomain: oauth.domain,
                    TokenScopesArray: oauth.scope,
                    RedirectUriSignIn: oauth.redirectSignIn,
                    RedirectUriSignOut: oauth.redirectSignOut,
                    ResponseType: oauth.responseType,
                    Storage: this._storage
                },
                oauth.options
            );

            logger.debug('cognito auth params', cognitoAuthParams);
            this._cognitoAuthClient = new CognitoAuth(cognitoAuthParams);
            this._cognitoAuthClient.userhandler = {
                // user signed in
                onSuccess: (result) => {
                    that.user = that.userPool.getCurrentUser();
                    logger.debug("Cognito Hosted authentication result", result);
                    that.currentSession().then(async (session) => {
                        try {
                            await Credentials.clear();
                            const cred = await Credentials.set(session, 'session');
                            logger.debug('sign in succefully with', cred);
                        } catch (e) {
                            logger.debug('sign in without aws credentials', e);
                        } finally {
                            dispatchAuthEvent('signIn', that.user);
                            dispatchAuthEvent('cognitoHostedUI', that.user);
                        }
                    });
                },
                onFailure: (err) => {
                    logger.debug("Error in cognito hosted auth response", err);
                    dispatchAuthEvent('signIn_failure', err);
                }
            };
            // if not logged in, try to parse the url.
            this.currentAuthenticatedUser().then(() => {
                logger.debug('user already logged in');
            }).catch(e => {
                logger.debug('not logged in, try to parse the url');
                if (!window || !window.location) {
                    logger.debug('not in the browser');
                    return;
                }
                const curUrl = window.location.href;
                this._cognitoAuthClient.parseCognitoWebResponse(curUrl);
            });
        }

        dispatchAuthEvent('configured', null);
        return this._config;
    }

    /**
     * Sign up with username, password and other attrbutes like phone, email
     * @param {String | object} params - The user attirbutes used for signin
     * @param {String[]} restOfAttrs - for the backward compatability
     * @return - A promise resolves callback data if success
     */
    public signUp(params: string | object, ...restOfAttrs: string[]): Promise<any> {
        if (!this.userPool) { return Promise.reject('No userPool'); }

        let username : string = null;
        let password : string = null;
        const attributes : object[] = [];
        let validationData: object[] = null;
        if (params && typeof params === 'string') {
            username = params;
            password = restOfAttrs? restOfAttrs[0] : null;
            const email : string = restOfAttrs? restOfAttrs[1] : null;
            const phone_number : string = restOfAttrs? restOfAttrs[2] : null;
            if (email) attributes.push({Name: 'email', Value: email});
            if (phone_number) attributes.push({Name: 'phone_number', Value: phone_number});
        } else if (params && typeof params === 'object') {
            username = params['username'];
            password = params['password'];
            const attrs = params['attributes'];
            if (attrs) {
                Object.keys(attrs).map(key => {
                    const ele : object = { Name: key, Value: attrs[key] };
                    attributes.push(ele);
                });
            }
            validationData = params['validationData'] || null;
        } else {
            return Promise.reject('The first parameter should either be non-null string or object');
        }

        if (!username) { return Promise.reject('Username cannot be empty'); }
        if (!password) { return Promise.reject('Password cannot be empty'); }

        logger.debug('signUp attrs:', attributes);
        logger.debug('signUp validation data:', validationData);
 

        return new Promise((resolve, reject) => {
            this.userPool.signUp(username, password, attributes, validationData, function(err, data) {
                if (err) {
                    dispatchAuthEvent('signUp_failure', err);
                    reject(err);
                } else {
                    dispatchAuthEvent('signUp', data);
                    resolve(data);
                }
            });
        });
    }

    /**
     * Send the verfication code to confirm sign up
     * @param {String} username - The username to be confirmed
     * @param {String} code - The verification code
     * @param {ConfirmSignUpOptions} options - other options for confirm signup
     * @return - A promise resolves callback data if success
     */
    public confirmSignUp(username: string, code: string, options?: ConfirmSignUpOptions): Promise<any> {
        if (!this.userPool) { return Promise.reject('No userPool'); }
        if (!username) { return Promise.reject('Username cannot be empty'); }
        if (!code) { return Promise.reject('Code cannot be empty'); }

        const user = this.createCognitoUser(username);
        const forceAliasCreation = options && typeof options.forceAliasCreation === 'boolean'
            ? options.forceAliasCreation : true;

        return new Promise((resolve, reject) => {
            user.confirmRegistration(code, forceAliasCreation, function(err, data) {
                if (err) { reject(err); } else { resolve(data); }
            });
        });
    }

    /**
     * Resend the verification code
     * @param {String} username - The username to be confirmed
     * @return - A promise resolves data if success
     */
    public resendSignUp(username: string): Promise<any> {
        if (!this.userPool) { return Promise.reject('No userPool'); }
        if (!username) { return Promise.reject('Username cannot be empty'); }

        const user = this.createCognitoUser(username);
        return new Promise((resolve, reject) => {
            user.resendConfirmationCode(function(err, data) {
                if (err) { reject(err); } else { resolve(data); }
            });
        });
    }

    /**
     * Sign in
     * @param {String} username - The username to be signed in
     * @param {String} password - The password of the username
     * @return - A promise resolves the CognitoUser
     */
    public signIn(username: string, password?: string): Promise<any> {
        if (!this.userPool) { return Promise.reject('No userPool'); }
        if (!username) { return Promise.reject('Username cannot be empty'); }

        if (password) {
            return this.signInWithPassword(username, password);
        } else {
            return this.signInWithoutPassword(username);
        }
    }

    /**
     * Return an object with the authentication callbacks
     * @param {CognitoUser} user - the cognito user object
     * @param {} resolve - function called when resolving the current step
     * @param {} reject - function called when rejecting the current step
     * @return - an object with the callback methods for user authentication
     */
    private authCallbacks(user, resolve: (value?: any) => void, reject: (value?: any) => void) {
        const that = this;
        return {
            onSuccess: async (session) => {
                logger.debug(session);
                delete(user['challengeName']);
                delete(user['challengeParam']);
                try {
                    await Credentials.clear();
                    const cred = await Credentials.set(session, 'session');
                    logger.debug('succeed to get cognito credentials', cred);
                } catch (e) {
                    logger.debug('cannot get cognito credentials', e);
                } finally {
                    that.user = user;
                    dispatchAuthEvent('signIn', user);
                    resolve(user);
                }
            },
            onFailure: (err) => {
                logger.debug('signIn failure', err);
                dispatchAuthEvent('signIn_failure', err);
                reject(err);
            },
            customChallenge: (challengeParam) => {
                logger.debug('signIn custom challenge answer required');
                user['challengeName'] = 'CUSTOM_CHALLENGE';
                user['challengeParam'] = challengeParam;
                resolve(user);
            },
            mfaRequired: (challengeName, challengeParam) => {
                logger.debug('signIn MFA required');
                user['challengeName'] = challengeName;
                user['challengeParam'] = challengeParam;
                resolve(user);
            },
            mfaSetup: (challengeName, challengeParam) => {
                logger.debug('signIn mfa setup', challengeName);
                user['challengeName'] = challengeName;
                user['challengeParam'] = challengeParam;
                resolve(user);
            },
            newPasswordRequired: (userAttributes, requiredAttributes) => {
                logger.debug('signIn new password');
                user['challengeName'] = 'NEW_PASSWORD_REQUIRED';
                user['challengeParam'] = {
                    userAttributes,
                    requiredAttributes
                };
                resolve(user);
            },
            totpRequired: (challengeName, challengeParam) => {
                logger.debug('signIn totpRequired');
                user['challengeName'] = challengeName;
                user['challengeParam'] = challengeParam;
                resolve(user);
            },
            selectMFAType: (challengeName, challengeParam) => {
                logger.debug('signIn selectMFAType', challengeName);
                user['challengeName'] = challengeName;
                user['challengeParam'] = challengeParam;
                resolve(user);
            }
        };
    }

    /**
     * Sign in with a password
     * @param {String} username - The username to be signed in
     * @param {String} password - The password of the username
     * @return - A promise resolves the CognitoUser object if success or mfa required
     */
    private signInWithPassword(username: string, password: string): Promise<any> {
        const user = this.createCognitoUser(username);
        const authDetails = new AuthenticationDetails({
            Username: username,
            Password: password
        });

        return new Promise((resolve, reject) => {
            user.authenticateUser(authDetails, this.authCallbacks(user, resolve, reject));
        });
    }

    /**
     * Sign in without a password
     * @param {String} username - The username to be signed in
     * @return - A promise resolves the CognitoUser object if success or mfa required
     */
    private signInWithoutPassword(username: string): Promise<any> {
        const user = this.createCognitoUser(username);
        user.setAuthenticationFlowType('CUSTOM_AUTH');
        const authDetails = new AuthenticationDetails({
            Username: username
        });

        return new Promise((resolve, reject) => {
            user.initiateAuth(authDetails, this.authCallbacks(user, resolve, reject));
        });
    }

    /**
     * get user current preferred mfa option
     * this method doesn't work with totp, we need to deprecate it.
     * @deprecated
     * @param {CognitoUser} user - the current user
     * @return - A promise resolves the current preferred mfa option if success
     */
    public getMFAOptions(user : any) : Promise<any> {
        return new Promise((res, rej) => {
            user.getMFAOptions((err, mfaOptions) => {
                if (err) {
                    logger.debug('get MFA Options failed', err);
                    rej(err);
                    return;
                }
                logger.debug('get MFA options success', mfaOptions);
                res(mfaOptions);
                return;
            });
        });
    }

    /**
     * get preferred mfa method
     * @param {CognitoUser} user - the current cognito user
     */
    public getPreferredMFA(user: any): Promise<string> {
        const that = this;
        return new Promise((res, rej) => {
            user.getUserData((err, data) => {
                if (err) {
                    logger.debug('getting preferred mfa failed', err);
                    rej(err);
                    return;
                }
                
                const mfaType = that._getMfaTypeFromUserData(data);
                if (!mfaType) {
                    rej('invalid MFA Type');
                    return;
                } else {
                    res(mfaType);
                    return;
                }
            });
        });
    }

    private _getMfaTypeFromUserData(data) {
        let ret = null;
        const preferredMFA = data.PreferredMfaSetting;
        // if the user has used Auth.setPreferredMFA() to setup the mfa type
        // then the "PreferredMfaSetting" would exist in the response
        if (preferredMFA) {
            ret = preferredMFA;
        } else {
            // if mfaList exists but empty, then its noMFA
            const mfaList = data.UserMFASettingList;
            if (!mfaList) {
                // if SMS was enabled by using Auth.enableSMS(), 
                // the response would contain MFAOptions
                // as for now Cognito only supports for SMS, so we will say it is 'SMS_MFA'
                // if it does not exist, then it should be NOMFA
                const MFAOptions = data.MFAOptions;
                if (MFAOptions) {
                    ret = 'SMS_MFA';
                } else {
                    ret = 'NOMFA';
                }
            } else if (mfaList.length === 0) {
                ret = 'NOMFA';
            } else {
                logger.debug('invalid case for getPreferredMFA', data);
            }
        }
        return ret;
    }
    
    private _getUserData(user) {
        return new Promise((res, rej) => {
            user.getUserData((err, data) => {
                if (err) {
                    logger.debug('getting user data failed', err);
                    rej(err);
                    return;
                } else {
                    res(data);
                    return;
                }
            });
        });
        
    }
    /**
     * set preferred MFA method
     * @param {CognitoUser} user - the current Cognito user
     * @param {string} mfaMethod - preferred mfa method
     * @return - A promise resolve if success
     */
    public async setPreferredMFA(user : any, mfaMethod : string): Promise<any> {
        const userData = await this._getUserData(user);
        let smsMfaSettings = null;
        let totpMfaSettings = null;

        switch(mfaMethod) {
            case 'TOTP' || 'SOFTWARE_TOKEN_MFA':
                totpMfaSettings = {
                    PreferredMfa : true,
                    Enabled : true
                };
                break;
            case 'SMS' || 'SMS_MFA':
                smsMfaSettings = {
                    PreferredMfa : true,
                    Enabled : true
                };
                break;
            case 'NOMFA':
                const mfaList = userData['UserMFASettingList'];
                const currentMFAType = await this._getMfaTypeFromUserData(userData);
                if (currentMFAType === 'NOMFA') {
                    return Promise.resolve('No change for mfa type');
                } else if (currentMFAType === 'SMS_MFA') {
                    smsMfaSettings = {
                        PreferredMfa : false,
                        Enabled : false
                    };
                } else if (currentMFAType === 'SOFTWARE_TOKEN_MFA') {
                    totpMfaSettings = {
                        PreferredMfa : false,
                        Enabled : false
                    };
                } else {
                    return Promise.reject('invalid MFA type');
                }
                // if there is a UserMFASettingList in the response
                // we need to disable every mfa type in that list
                if (mfaList && mfaList.length !== 0) {
                    // to disable SMS or TOTP if exists in that list
                    mfaList.forEach(mfaType => {
                        if (mfaType === 'SMS_MFA') {
                            smsMfaSettings = {
                                PreferredMfa : false,
                                Enabled : false
                            };
                        } else if (mfaType === 'SOFTWARE_TOKEN_MFA') {
                            totpMfaSettings = {
                                PreferredMfa : false,
                                Enabled : false
                            };
                        }
                    });
                }
                break;
            default:
                logger.debug('no validmfa method provided');
                return Promise.reject('no validmfa method provided');
        }

        const that = this;
        return new Promise((res, rej) => {
            user.setUserMfaPreference(smsMfaSettings, totpMfaSettings, (err, result) => {
                if (err) {
                    logger.debug('Set user mfa preference error', err);
                    rej(err);
                    return;
                }
                logger.debug('Set user mfa success', result);
                res(result);
                return;
            });
        });
    }

    /**
     * diable SMS
     * @deprecated
     * @param {CognitoUser} user - the current user
     * @return - A promise resolves is success
     */
    public disableSMS(user : any) : Promise<any> {
        return new Promise((res, rej) => {
            user.disableMFA((err, data) => {
                if (err) {
                    logger.debug('disable mfa failed', err);
                    rej(err);
                    return;
                }
                logger.debug('disable mfa succeed', data);
                res(data);
                return;
            });
        });
    }

    /**
     * enable SMS
     * @deprecated
     * @param {CognitoUser} user - the current user
     * @return - A promise resolves is success
     */
    public enableSMS(user) {
        return new Promise((res, rej) => {
            user.enableMFA((err, data) => {
                if (err) {
                    logger.debug('enable mfa failed', err);
                    rej(err);
                    return;
                }
                logger.debug('enable mfa succeed', data);
                res(data);
                return;
            });
        });
    }

    /**
     * Setup TOTP
     * @param {CognitoUser} user - the current user
     * @return - A promise resolves with the secret code if success
     */
    public setupTOTP(user) {
        return new Promise((res, rej) => {
            user.associateSoftwareToken({
                onFailure: (err) => {
                    logger.debug('associateSoftwareToken failed', err);
                    rej(err);
                    return;
                },
                associateSecretCode: (secretCode) => {
                    logger.debug('associateSoftwareToken sucess', secretCode);
                    res(secretCode);
                    return;
                }
            });
        });
    }

    /**
     * verify TOTP setup
     * @param {CognitoUser} user - the current user
     * @param {string} challengeAnswer - challenge answer
     * @return - A promise resolves is success
     */
    public verifyTotpToken(user, challengeAnswer) {
        logger.debug('verfication totp token', user, challengeAnswer);
        return new Promise((res, rej) => {
            user.verifySoftwareToken(challengeAnswer, 'My TOTP device', {
                onFailure: (err) => {
                    logger.debug('verifyTotpToken failed', err);
                    rej(err);
                    return;
                },
                onSuccess: (data) => {
                    logger.debug('verifyTotpToken success', data);
                    res(data);
                    return;
                }
            });
        });
    }

    /**
     * Send MFA code to confirm sign in
     * @param {Object} user - The CognitoUser object
     * @param {String} code - The confirmation code
     */
    public confirmSignIn(user: any, code: string, mfaType: string | null): Promise<any> {
        if (!code) { return Promise.reject('Code cannot be empty'); }

        const that = this;
        return new Promise((resolve, reject) => {
            user.sendMFACode(
                code, {
                    onSuccess: async (session) => {
                        logger.debug(session);
                        try {
                            await Credentials.clear();
                            const cred = await Credentials.set(session, 'session');
                            logger.debug('succeed to get cognito credentials', cred);
                        } catch (e) {
                            logger.debug('cannot get cognito credentials', e);
                        } finally {
                            that.user = user;
                            dispatchAuthEvent('signIn', user);
                            resolve(user);
                        }
                    },
                    onFailure: (err) => {
                        logger.debug('confirm signIn failure', err);
                        reject(err);
                    }
                }, 
                mfaType);
        });
    }

    public completeNewPassword(
        user: any,
        password: string,
        requiredAttributes: any
    ): Promise<any> {
        if (!password) { return Promise.reject('Password cannot be empty'); }

        const that = this;
        return new Promise((resolve, reject) => {
            user.completeNewPasswordChallenge(password, requiredAttributes, {
                onSuccess: async (session) => {
                    logger.debug(session);
                    try {
                        await Credentials.clear();
                        const cred = await Credentials.set(session, 'session');
                        logger.debug('succeed to get cognito credentials', cred);
                    } catch (e) {
                        logger.debug('cannot get cognito credentials', e);
                    } finally {
                        that.user = user;
                        dispatchAuthEvent('signIn', user);
                        resolve(user);
                    }
                },
                onFailure: (err) => {
                    logger.debug('completeNewPassword failure', err);
                    dispatchAuthEvent('completeNewPassword_failure', err);
                    reject(err);
                },
                mfaRequired: (challengeName, challengeParam) => {
                    logger.debug('signIn MFA required');
                    user['challengeName'] = challengeName;
                    user['challengeParam'] = challengeParam;
                    resolve(user);
                },
                mfaSetup: (challengeName, challengeParam) => {
                    logger.debug('signIn mfa setup', challengeName);
                    user['challengeName'] = challengeName;
                    user['challengeParam'] = challengeParam;
                    resolve(user);
                }
            });
        });
    }

    /**
     * Send the answer to a custom challenge
     * @param {CognitoUser} user - The CognitoUser object
     * @param {String} challengeResponses - The confirmation code
     */
    public sendCustomChallengeAnswer(user, challengeResponses: string): Promise<any> {
        if (!this.userPool) { return Promise.reject('No userPool'); }
        if (!challengeResponses) { return Promise.reject('Challenge response cannot be empty'); }

        const that = this;
        return new Promise((resolve, reject) => {
            user.sendCustomChallengeAnswer(challengeResponses, this.authCallbacks(user, resolve, reject));
        });
    }

    /**
     * Update an authenticated users' attributes
     * @param {CognitoUser} - The currently logged in user object
     * @return {Promise}
     **/
    public updateUserAttributes(user, attributes:object): Promise<any> {
        let attr:object = {};
        const attributeList:Array<object> = [];
        return this.userSession(user)
            .then(session => {
                return new Promise((resolve, reject) => {
                    for (const key in attributes) {
                        if ( key !== 'sub' &&
                            key.indexOf('_verified') < 0) {
                            attr = {
                                'Name': key,
                                'Value': attributes[key]
                            };
                            attributeList.push(attr);
                        }
                    }
                    user.updateAttributes(attributeList, (err,result) => {
                        if (err) { 
                            reject(err); 
                            return;
                        } else { 
                            resolve(result); 
                            return;
                        }
                    });
                });
            });
    }
    /**
     * Return user attributes
     * @param {Object} user - The CognitoUser object
     * @return - A promise resolves to user attributes if success
     */
    public userAttributes(user): Promise<any> {
        return this.userSession(user)
            .then(session => {
                return new Promise((resolve, reject) => {
                    user.getUserAttributes((err, attributes) => {
                        if (err) { reject(err); } else { resolve(attributes); }
                    });
                });
            });
    }

    public verifiedContact(user) {
        const that = this;
        return this.userAttributes(user)
            .then(attributes => {
                const attrs = that.attributesToObject(attributes);
                const unverified = {};
                const verified = {};
                if (attrs['email']) {
                    if (attrs['email_verified']) {
                        verified['email'] = attrs['email'];
                    } else {
                        unverified['email'] = attrs['email'];
                    }
                }
                if (attrs['phone_number']) {
                    if (attrs['phone_number_verified']) {
                        verified['phone_number'] = attrs['phone_number'];
                    } else {
                        unverified['phone_number'] = attrs['phone_number'];
                    }
                }
                return {
                    verified,
                    unverified
                };
            });
    }

    /**
     * Get current authenticated user
     * @return - A promise resolves to curret authenticated CognitoUser if success
     */
    public currentUserPoolUser(): Promise<any> {
        if (!this.userPool) { return Promise.reject('No userPool'); }
        const that = this;
        return new Promise((res, rej) => {
            this._storageSync.then(() => {
                const user = that.userPool.getCurrentUser();
                if (!user) { 
                    logger.debug('Failed to get user from user pool');
                    rej('No current user');
                    return;
                }

                // refresh the session if the session expired.
                user.getSession(function(err, session) {
                    if (err) {
                        logger.debug('Failed to get the user session', err);
                        rej(err); 
                        return;
                    }
                });

                // get user data from Cognito
                user.getUserData((err, data) => {
                    if (err) {
                        logger.debug('getting user data failed', err);
                        // Make sure the user is still valid
                        if (err.message === 'User is disabled' || err.message === 'User does not exist.') {
                            rej(err);
                        } else {
                            // the error may also be thrown when lack of permissions to get user info etc
                            // in that case we just bypass the error
                            res(user);
                        }
                        return;
                    }
                    const preferredMFA = data.PreferredMfaSetting || 'NOMFA';
                    const attributeList = [];

                    for (let i = 0; i < data.UserAttributes.length; i++) {
                        const attribute = {
                            Name: data.UserAttributes[i].Name,
                            Value: data.UserAttributes[i].Value,
                        };
                        const userAttribute = new CognitoUserAttribute(attribute);
                        attributeList.push(userAttribute);
                    }

                    const attributes = this.attributesToObject(attributeList);
                    Object.assign(user, {attributes, preferredMFA});
                    res(user);
                });
            });
        });
    }

    /**
     * Get current authenticated user
     * @return - A promise resolves to curret authenticated CognitoUser if success
     */
    public async currentAuthenticatedUser(): Promise<any> {
        logger.debug('getting current authenticted user');
        let federatedUser = null;
        try {
            federatedUser = JSON.parse(this._storage.getItem('aws-amplify-federatedInfo')).user;
        } catch (e) {
            logger.debug('cannot load federated user from auth storage');
        }
        
        if (federatedUser) {
            this.user = federatedUser;
            logger.debug('get current authenticated federated user', this.user);
            return this.user;
        } else {
            logger.debug('get current authenticated userpool user');
            let user = null;
            try {
                user = await this.currentUserPoolUser();
            } catch (e) {
                logger.debug('The user is not authenticated by the error', e);
                throw ('not authenticated');
            }
            this.user = user;
            return this.user;
        }
    }

    /**
     * Get current user's session
     * @return - A promise resolves to session object if success
     */
    public currentSession() : Promise<any> {
        const that = this;
        logger.debug('Getting current session');
        if (!this.userPool) { return Promise.reject('No userPool'); }

        return new Promise((res, rej) => {
            that.currentUserPoolUser().then(user => {
                that.userSession(user).then(session => {
                    res(session);
                    return;
                }).catch(e => {
                    logger.debug('Failed to get the current session', e);
                    rej(e);
                    return;
                });
            }).catch(e => {
                logger.debug('Failed to get the current user', e);
                rej(e);
                return;
            });
        });
    }

    /**
     * Get the corresponding user session
     * @param {Object} user - The CognitoUser object
     * @return - A promise resolves to the session
     */
    public userSession(user) : Promise<any> {
        if (!user) {
            logger.debug('the user is null');
            return Promise.reject('Failed to get the session because the user is empty');
        }
        return new Promise((resolve, reject) => {
            logger.debug('Getting the session from this user:', user);
            user.getSession(function(err, session) {
                if (err) { 
                    logger.debug('Failed to get the session from user', user);
                    reject(err);
                    return;
                } else {
                    logger.debug('Succeed to get the user session', session);
                    resolve(session); 
                    return;
                }
            });
        });
    }

    /**
     * Get authenticated credentials of current user.
     * @return - A promise resolves to be current user's credentials
     */
    public currentUserCredentials() {
        const that = this;
        logger.debug('Getting current user credentials');
        
        // first to check whether there is federation info in the auth storage
        let federatedInfo = null;
        try {
            federatedInfo = JSON.parse(this._storage.getItem('aws-amplify-federatedInfo'));
        } catch (e) {
            logger.debug('failed to get or parse item aws-amplify-federatedInfo', e);
        }

        if (federatedInfo) {
            // refresh the jwt token here if necessary
            return Credentials.refreshFederatedToken(federatedInfo);
        } else {
            return this.currentSession()
                .then(session => {
                    logger.debug('getting session success', session);
                    return Credentials.set(session, 'session');
                }).catch((error) => {
                    logger.debug('getting session failed', error);
                    return Credentials.set(null, 'guest');
                });
        }
    }


    public currentCredentials(): Promise<any> {
        logger.debug('getting current credntials');
        return Credentials.get();
    }

    /**
     * Initiate an attribute confirmation request
     * @param {Object} user - The CognitoUser
     * @param {Object} attr - The attributes to be verified
     * @return - A promise resolves to callback data if success
     */
    public verifyUserAttribute(user, attr): Promise<any> {
        return new Promise((resolve, reject) => {
            user.getAttributeVerificationCode(attr, {
                onSuccess(data) { 
                    resolve(data); 
                    return;
                },
                onFailure(err) {
                    reject(err); 
                    return;
                }
            });
        });
    }

    /**
     * Confirm an attribute using a confirmation code
     * @param {Object} user - The CognitoUser
     * @param {Object} attr - The attribute to be verified
     * @param {String} code - The confirmation code
     * @return - A promise resolves to callback data if success
     */
    public verifyUserAttributeSubmit(user, attr, code): Promise<any> {
        if (!code) { return Promise.reject('Code cannot be empty'); }

        return new Promise((resolve, reject) => {
            user.verifyAttribute(attr, code, {
                onSuccess(data) { 
                    resolve(data); 
                    return;
                },
                onFailure(err) { 
                    reject(err); 
                    return;
                }
            });
        });
    }

    verifyCurrentUserAttribute(attr) {
        const that = this;
        return that.currentUserPoolUser()
            .then(user => that.verifyUserAttribute(user, attr));
    }

    /**
     * Confirm current user's attribute using a confirmation code
     * @param {Object} attr - The attribute to be verified
     * @param {String} code - The confirmation code
     * @return - A promise resolves to callback data if success
     */
    verifyCurrentUserAttributeSubmit(attr, code) {
        const that = this;
        return that.currentUserPoolUser()
            .then(user => that.verifyUserAttributeSubmit(user, attr, code));
    }
    /**
     * Sign out method
     * @return - A promise resolved if success
     */
    public async signOut(): Promise<any> {
        try {
            await this.cleanCachedItems();
        } catch (e) {
            logger.debug('failed to clear cached items');
        }

        if (this.userPool) { 
            const user = this.userPool.getCurrentUser();
            if (user) {
                logger.debug('user sign out', user);
                user.signOut();
                if (this._cognitoAuthClient) {
                    this._cognitoAuthClient.signOut();
                }
            }
        } else {
            logger.debug('no Congito User pool');
        }
        
        const that = this;
        return new Promise(async (resolve, reject) => {
            try {
                await Credentials.set(null, 'guest');
            } catch (e) {
                logger.debug('cannot load guest credentials for unauthenticated user', e);
            } finally {
                dispatchAuthEvent('signOut', that.user);
                that.user = null;
                resolve();
            }
        });
    }

    private async cleanCachedItems() {
        // clear cognito cached item
        await Credentials.clear();
    }

    /**
     * Change a password for an authenticated user
     * @param {Object} user - The CognitoUser object
     * @param {String} oldPassword - the current password
     * @param {String} newPassword - the requested new password
     * @return - A promise resolves if success
     */
    public changePassword(user: any, oldPassword: string, newPassword: string): Promise<any> {
        return this.userSession(user)
            .then(session => {
                return new Promise((resolve, reject) => {
                    user.changePassword(oldPassword, newPassword, (err, data) => {
                        if (err) {
                            logger.debug('change password failure', err);
                            reject(err);
                            return;
                        } else {
                            resolve(data);
                            return;
                        }
                    });
                });
            });
    }

    /**
     * Initiate a forgot password request
     * @param {String} username - the username to change password
     * @return - A promise resolves if success
     */
    public forgotPassword(username: string): Promise<any> {
        if (!this.userPool) { return Promise.reject('No userPool'); }
        if (!username) { return Promise.reject('Username cannot be empty'); }

        const user = this.createCognitoUser(username);
        return new Promise((resolve, reject) => {
            user.forgotPassword({
                onSuccess: () => { 
                    resolve();
                    return; 
                },
                onFailure: err => {
                    logger.debug('forgot password failure', err);
                    reject(err);
                    return;
                },
                inputVerificationCode: data => {
                    resolve(data);
                    return;
                }
            });
        });
    }

    /**
     * Confirm a new password using a confirmation Code
     * @param {String} username - The username
     * @param {String} code - The confirmation code
     * @param {String} password - The new password
     * @return - A promise that resolves if success
     */
    public forgotPasswordSubmit(
        username: string,
        code: string,
        password: string
    ): Promise<any> {
        if (!this.userPool) { return Promise.reject('No userPool'); }
        if (!username) { return Promise.reject('Username cannot be empty'); }
        if (!code) { return Promise.reject('Code cannot be empty'); }
        if (!password) { return Promise.reject('Password cannot be empty'); }

        const user = this.createCognitoUser(username);
        return new Promise((resolve, reject) => {
            user.confirmPassword(code, password, {
                onSuccess: () => { 
                    resolve(); 
                    return;
                },
                onFailure: err => { 
                    reject(err); 
                    return;
                }
            });
        });
    }

    /**
     * Get user information
     * @async
     * @return {Object }- current User's information
     */
    public async currentUserInfo() {
        const source = Credentials.getCredSource();

        if (!source || source === 'aws' || source === 'userPool') {
            const user = await this.currentUserPoolUser()
                .catch(err => logger.debug(err));
            if (!user) { return null; }

            try {
                const attributes = await this.userAttributes(user);
                const userAttrs:object = this.attributesToObject(attributes);
                let credentials = null;
                try {
                    credentials = await this.currentCredentials();
                } catch (e) {
                    logger.debug('Failed to retrieve credentials while getting current user info', e);
                }
                

                const info = {
                    'id': credentials? credentials.identityId : undefined,
                    'username': user.username,
                    'attributes': userAttrs
                };
                return info;
            } catch(err) {
                logger.debug('currentUserInfo error', err);
                return {};
            }
        }

        if (source === 'federated') {
            const user = this.user;
            return user? user : {};
        }
    }

    /**
     * For federated login
     * @param {String} provider - federation login provider
     * @param {FederatedResponse} response - response should have the access token
     * the identity id (optional)
     * and the expiration time (the universal time)
     * @param {String} user - user info
     */
    public federatedSignIn(provider: string, response: FederatedResponse, user: object) {
        const { token, identity_id, expires_at } = response;
        const that = this;
        return new Promise((res, rej) => {
            Credentials.set({ provider, token, identity_id, user, expires_at }, 'federation').then((cred) => {
                dispatchAuthEvent('signIn', that.user);
                logger.debug('federated sign in credentials', cred);
                res(cred);
                return;
            }).catch(e => {
                rej(e);
                return;
            });
        });    
    }

    /**
     * Compact version of credentials
     * @param {Object} credentials
     * @return {Object} - Credentials
     */
    public essentialCredentials(credentials) {
        return {
            accessKeyId: credentials.accessKeyId,
            sessionToken: credentials.sessionToken,
            secretAccessKey: credentials.secretAccessKey,
            identityId: credentials.identityId,
            authenticated: credentials.authenticated
        };
    }

    private attributesToObject(attributes) {
        const obj = {};
        if (attributes) {
            attributes.map(attribute => {
                if (attribute.Name === 'sub') return;

                if (attribute.Value === 'true') {
                    obj[attribute.Name] = true;
                } else if (attribute.Value === 'false') {
                    obj[attribute.Name] = false;
                } else {
                    obj[attribute.Name] = attribute.Value;
                }
            });
        }
        return obj;
    }
    
    private createCognitoUser(username: string): CognitoUser {
        const userData: ICognitoUserData = {
            Username: username,
            Pool: this.userPool,
        };
        userData.Storage = this._storage;

        const { authenticationFlowType } = this._config;
        
        const user = new CognitoUser(userData);
        if (authenticationFlowType) {
            user.setAuthenticationFlowType(authenticationFlowType);
        }
        return user;
    }
}
