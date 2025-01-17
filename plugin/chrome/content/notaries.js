/*
*   This file is part of the Perspectives Firefox Client
*
*   Copyright (C) 2011 Dan Wendlandt
*
*   This program is free software: you can redistribute it and/or modify
*   it under the terms of the GNU General Public License as published by
*   the Free Software Foundation, version 3 of the License.
*
*   This program is distributed in the hope that it will be useful,
*   but WITHOUT ANY WARRANTY; without even the implied warranty of
*   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
*   GNU General Public License for more details.
*
*   You should have received a copy of the GNU General Public License
*   along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

var Perspectives = {
 	MY_ID: "perspectives@cmu.edu",
	TIMEOUT_SEC: 5,  // this is timeout for each query to the server
	NUM_TRIES_PER_SERVER: 2, // number of times we query a server before giving up 
	strbundle : null, // this isn't loaded when things are intialized


	// FIXME: these regexes should be less generous
	nonrouted_ips : [ "^192\.168\.", "^10.", "^172\.1[6-9]\.", 
			"^172\.2[0-9]\.", "172\.3[0-1]\.", "^169\.254\.", 
			"^127\.0\.0\.1$"], // could add many more

	// list of objects representing each notary server's name + port and public
	// key this list is populated by fillNotaryList() based on a file shipped with the 
	// extension
	all_notaries : [],  

	// Data

	// See init_data().
	// Always call init_data() before working with these variables!
	root_prefs : null,
	overrideService : null,

	/*
	Note: calls to Components.classes.getService() require special permissions.
	If we set the value of data properties at object creation time,
	(i.e. as part of the variable definition statements, above)
	anything that doesn't have permission, such as an HTML file including
	notaries.js as a script, will fail and not be able to use this object.
	Thus, we initialize data properties inside a function instead,
	so the caller can have control over when that happens
	and ask for permission beforehand if necessary.
	This helps to ensure Perspectives can be properly parsed and used
	in many situations.
	*/
	init_data: function() {
		var success = true;

		if (Perspectives.root_prefs == null) {
			var prefstr = "@mozilla.org/preferences-service;1";
			if (prefstr in Components.classes) {
				Perspectives.root_prefs = Components.classes[prefstr].
					getService(Components.interfaces.nsIPrefBranchInternal);
			}
			else {
				Pers_debug.d_print("error",
					"Could not define Perspectives.root_prefs!");
				success = false;
			}
		}

		if (Perspectives.overrideService == null) {
			var servstr = "@mozilla.org/security/certoverride;1";
			if (servstr in Components.classes) {
				Perspectives.overrideService = Components.classes[servstr].
					getService(Components.interfaces.nsICertOverrideService);
			}
			else {
				Pers_debug.d_print("error",
					"Could not define Perspectives.overrideServices!");
				success = false;
			}
		}
		//TODO: initialize data from other objects here too

		return success;
	},
	
	state : {
		STATE_IS_BROKEN : 
			Components.interfaces.nsIWebProgressListener.STATE_IS_BROKEN,
		STATE_IS_INSECURE :
			Components.interfaces.nsIWebProgressListener.STATE_IS_INSECURE,
		STATE_IS_SECURE :
			Components.interfaces.nsIWebProgressListener.STATE_IS_SECURE
	},

	is_nonrouted_ip: function(ip_str) { 
		for each (regex in Perspectives.nonrouted_ips) { 
			if(ip_str.match(RegExp(regex))) { 
				return true; 
			}
		} 
		return false; 
	}, 


	// flag to make sure we only show component load failed alert once
	// per Firefox session.  Otherwise, the user gets flooded with it.  
	show_component_failed : true,

	tab_info_cache : {}, 

	//Sets the tooltip and the text of the favicon popup on https sites
	setFaviconText: function(str){
        	var box = document.getElementById("identity-box");
        	if(box)
            		box.tooltipText = str;
        	else { // SeaMonkey
            		box = document.getElementById("security-button");
            		if(box)
               		box.tooltipText = str;
        	}
	},

	getFaviconText: function(){
        	var box = document.getElementById("identity-box");
        	if(box)
            		return box.tooltipText;
        	// SeaMonkey
        	box = document.getElementById("security-button");
        	if(box)
            		return box.tooltipText;
	},

	// cached result data 
	// FIXME: this should be merged with TabInfo, once TabInfo is made into a 
	// real object
	SslCert: function(host, port, md5, summary, tooltip, svg, duration, cur_consistent, 
					inconsistent_results,weakly_seen, server_result_list){
		this.host     = host;  // now saved with ti, so remove this?
		this.port     = port;  // now saved with ti, so remove this? 
		this.md5      = md5;
		this.cur_consistent   = cur_consistent;
		this.inconsistent_results = inconsistent_results; 
		this.weakly_seen = weakly_seen, 
		this.duration = duration;
		this.summary  = summary;  // this doesn't really need to be cached
		this.tooltip  = tooltip;
		this.svg      = svg;  // this doesn't really need to be cached
		this.server_result_list = server_result_list; 
		this.created = Pers_util.get_unix_time(); 
	},

	get_invalid_cert_SSLStatus: function(uri){
		var recentCertsSvc = 
		Components.classes["@mozilla.org/security/recentbadcerts;1"]
			.getService(Components.interfaces.nsIRecentBadCertsService);
		if (!recentCertsSvc)
			return null;

		var port = (uri.port == -1) ? 443 : uri.port;  

		var hostWithPort = uri.host + ":" + port;
		var gSSLStatus = recentCertsSvc.getRecentBadCert(hostWithPort);
		if (!gSSLStatus)
			return null;
		return gSSLStatus;
	},

	// gets current certificate, if it FAILED the security check 
	psv_get_invalid_cert: function(uri) { 
		var gSSLStatus = Perspectives.get_invalid_cert_SSLStatus(uri);
		if(!gSSLStatus){
			return null;
		}
		return gSSLStatus.QueryInterface(Components.interfaces.nsISSLStatus)
				.serverCert;
	}, 

	// gets current certificate, if it PASSED the browser check 
	psv_get_valid_cert: function(ui) { 
		try { 
			ui.QueryInterface(Components.interfaces.nsISSLStatusProvider); 
			if(!ui.SSLStatus) 
				return null; 
			return ui.SSLStatus.serverCert; 
		}
		catch (e) {
			Pers_debug.d_print("error", "Perspectives Error: " + e); 
			return null;
		}
	}, 

	getCertificate: function(browser){
		var uri = browser.currentURI;
		var ui  = browser.securityUI;
		var cert = this.psv_get_valid_cert(ui);
		if(!cert){
			cert = this.psv_get_invalid_cert(uri);  
		}

		if(!cert) {
			return null;
		}
		return cert;
	},

	getNotaryList: function() { 
		var all_notaries = []; 
		try {
			var list_txt = Perspectives.root_prefs.getCharPref("perspectives.additional_notary_list");
			additional_notaries = Pers_util.loadNotaryListFromString(list_txt); 
			all_notaries = all_notaries.concat(additional_notaries); 
		} catch(e) { 
			Pers_debug.d_print("error", "Error parsing additional notaries: " + e); 
		} 		
		var use_default_notaries = Perspectives.root_prefs.getBoolPref("perspectives.use_default_notary_list"); 
		if(use_default_notaries) {
 
			default_notaries = Pers_util.loadNotaryListFromString(
						this.root_prefs.getCharPref("perspectives.default_notary_list")); 
			all_notaries = all_notaries.concat(default_notaries); 
		} 
		return all_notaries; 
	}, 


	queryNotaries: function(ti){
		if(!ti.cert) { 
			Pers_debug.d_print("error","No certificate found for: " + ti.uri.host); 
			return null; 
		} 

		if(ti.partial_query_results != null) { 
			Pers_debug.d_print("main", 
				"Query already in progress for '" + ti.uri.host + "' not querying again"); 
			return; 
		}
 
		// send a request to each notary
		ti.partial_query_results = []; 
		for(i = 0; i < Perspectives.all_notaries.length; i++) {
			Pers_debug.d_print("main", "Sending query to notary " + Perspectives.all_notaries[i].host);  
			this.querySingleNotary(Perspectives.all_notaries[i],ti); 
		}
    
		ti.timeout_id = window.setTimeout(function() { 
			Perspectives.notaryQueryTimeout(ti,0); 		
		}, Perspectives.TIMEOUT_SEC * 1000 ); 

	},

	querySingleNotary: function(notary_server, ti) { 
		var port = (ti.uri.port == -1) ? 443 : ti.uri.port;  
		var full_url = "http://" + notary_server.host + 
				"?host=" + ti.uri.host + "&port=" + port + "&service_type=2&";
		Pers_debug.d_print("query", "sending query: '" + full_url + "'");
		var req  = XMLHttpRequest();
		req.open("GET", full_url, true);
		req.onreadystatechange = (function(evt) { 
					Perspectives.notaryAjaxCallback(ti, req, notary_server, ti.has_user_permission); 
		}); 
		req.send(null);
	}, 
 
       
	notaryQueryTimeout: function(ti, num_timeouts) {  
			try {  
				Pers_debug.d_print("query", "timeout #" + num_timeouts + 
						" querying for '" + ti.service_id + "'");
				Pers_debug.d_print("query", ti.partial_query_results); 
 
				if (ti.partial_query_results == null) { 
					ti.partial_query_results = []; // may have been deleted between now and then
				} 
			 
				// find out which notaries we still need a reply from 
				var missing_replies = [];  
				for(var i = 0; i < Perspectives.all_notaries.length; i++) { 
					var found = false;
					for(var j = 0; j < ti.partial_query_results.length; j++) { 
						if(Perspectives.all_notaries[i].host == 
								ti.partial_query_results[j].server) { 
							found = true; 
							break; 
						}
					} 
					if(!found) { 
						missing_replies.push(Perspectives.all_notaries[i])
					} 
				} 

				var is_final_timeout = (num_timeouts == Perspectives.NUM_TRIES_PER_SERVER); 
				if(is_final_timeout) { 
					// time is up, so just add empty results for missing
					// notaries and begin processing results 
					for(var i = 0; i < missing_replies.length; i++) { 
						// add empty result for this notary
						var res = { "server" : missing_replies[i].host, 
								"obs" : [] }; 
						ti.partial_query_results.push(res); 
					} 
					Perspectives.notaryQueriesComplete(ti);
				} else {
					// send another query to any of the servers we are missing
					// reset the timeout, incrementing the count of the number
					// of timeouts we have seen  
					for(var i = 0; i < missing_replies.length; i++) { 
						this.querySingleNotary(Perspectives.all_notaries[i],ti); 
					}
    
					ti.timeout_id = window.setTimeout(function() { 
						Perspectives.notaryQueryTimeout(ti, num_timeouts + 1); 		
					}, Perspectives.TIMEOUT_SEC * 1000 ); 
				} 
				
			} catch (e) { 
				Pers_debug.d_print("query", "error handling timeout"); 
				Pers_debug.d_print("query", e); 
			} 
	}, 
 
	notaryAjaxCallback: function(ti, req, notary_server) {  
	
		if (req.readyState == 4) {  
			if(req.status == 200){
				try { 							
 
					Pers_debug.d_print("query", req.responseText); 
					var server_node = req.responseXML.documentElement;
					var server_result = Pers_xml.
							parse_server_node(server_node,1);
					var bin_result = Pers_xml.
							pack_result_as_binary(server_result,ti.service_id);
					Pers_debug.d_print("query", 
						Pers_xml.resultToString(server_result,false)); 
					var verifier = 
						Cc["@mozilla.org/security/datasignatureverifier;1"].
							createInstance(Ci.nsIDataSignatureVerifier);
					var result = verifier.verifyData(bin_result, 
							server_result.signature, notary_server.public_key);
					if(!result) { 
						Pers_debug.d_print("error", "Invalid signature from : " + 
							notary_server.host); 
						return; 
					}
					server_result.server = notary_server.host; 
				
					var result_list = ti.partial_query_results; 
					if(result_list == null) { 
						Pers_debug.d_print("query",
							"Query reply from '" + notary_server.host + 
							"' for '" + ti.service_id + 
								"' has no query result data"); 
						return; 
					} 
				 	var i; 
					for(i = 0; i < result_list.length; i++) {
						if(result_list[i].server == server_result.server) { 
							Pers_debug.d_print("query", 
							  "Ignoring duplicate reply for '" + 
								ti.service_id + "' from '" +
								server_result.server + "'"); 
							return; 
						} 
					}   
					Pers_debug.d_print("query","adding result from: " + 
							notary_server.host); 
					result_list.push(server_result); 
  					 
					var num_replies = ti.partial_query_results.length;
					Pers_debug.d_print("query", "num_replies = " + num_replies + 
								" total = " + Perspectives.all_notaries.length); 
					if(num_replies == Perspectives.all_notaries.length) { 
						Pers_debug.d_print("query","got all server replies"); 	
						window.clearTimeout(ti.timeout_id);
						Perspectives.notaryQueriesComplete(ti);
					}
					  
				} catch (e) { 
					Pers_debug.d_print("error", "exception: " + e); 
				} 
			} else { // HTTP ERROR CODE
				Pers_debug.d_print("error", 
					"HTTP Error code '" + req.status + "' when querying notary");  
			}
		}  
	},  

	notaryQueriesComplete: function(ti) {
		try {
			var server_result_list = ti.partial_query_results; 
			delete ti.partial_query_results; 
			delete ti.timeout_id; 
			
			var test_key = ti.cert.md5Fingerprint.toLowerCase();
			// 2 days (FIXME: make this a pref)
			var max_stale_sec = 2 * 24 * 3600; 
			var q_thresh = Perspectives.root_prefs.
						getIntPref("perspectives.quorum_thresh") / 100;
			var q_required = Math.round(this.all_notaries.length * q_thresh);
			var unixtime = Pers_util.get_unix_time(); 
			var quorum_duration = Pers_client_policy.get_quorum_duration(test_key, 
					server_result_list, q_required, max_stale_sec,unixtime);  
			var is_cur_consistent = quorum_duration != -1;
		
	
			var weak_check_time_limit = Perspectives.root_prefs.
						getIntPref("perspectives.weak_consistency_time_limit");
			var inconsistent_check_max = Perspectives.root_prefs.
					getIntPref("perspectives.max_timespan_for_inconsistency_test");
			var is_inconsistent = Pers_client_policy.inconsistency_check(server_result_list,
							inconsistent_check_max, weak_check_time_limit);
			var weakly_seen = Pers_client_policy.key_weakly_seen_by_quorum(test_key, 
						server_result_list, q_required, weak_check_time_limit); 
				 
			var qd_days =  quorum_duration / (3600 * 24);
			if(qd_days > 5 || qd_days == 0) {
				qd_days = Math.round(qd_days); 
			} else { 
				qd_days = qd_days.toFixed(1); 
			}  
			var obs_text = ""; 
			for(var i = 0; i < server_result_list.length; i++) {
				obs_text += "\nNotary: " + server_result_list[i].server + "\n"; 
				obs_text += Pers_xml.resultToString(server_result_list[i]); 
			}  
			var qd_str = (is_cur_consistent) ? qd_days + " days" : "none";
			var str = "Notary Lookup for: " + ti.service_id + "\n";
    			str += "Browser's Key = '" + test_key + "'\n"; 
    			str += "Results:\n"; 
    			str += "Quorum duration: " + qd_str + "\n"; 
    			str += "Notary Observations: \n" + obs_text + "\n"; 
			//Pers_debug.d_print("main","\n" + str + "\n");	
			var svg = Pers_gen.get_svg_graph(ti.service_id, server_result_list, 30,
				unixtime,test_key, max_stale_sec);
			ti.query_results = new Perspectives.SslCert(ti.uri.host, 
										ti.uri.port, test_key, 
										str, null,svg, qd_days, 
										is_cur_consistent, 
										is_inconsistent, 
										weakly_seen, 
										server_result_list);
			Perspectives.process_notary_results(ti); 

		} catch (e) { 
			alert(e); 
		} 
	},

  
	do_override: function(browser, cert,isTemp) { 
		var uri = browser.currentURI;
		Pers_debug.d_print("main", "Do Override\n");

		var gSSLStatus = Perspectives.get_invalid_cert_SSLStatus(uri);
		if(gSSLStatus == null) { 
			return false; 
		} 
		var flags = 0;
		if(gSSLStatus.isUntrusted)
			flags |= Perspectives.overrideService.ERROR_UNTRUSTED;
		if(gSSLStatus.isDomainMismatch)
			flags |= Perspectives.overrideService.ERROR_MISMATCH;
		if(gSSLStatus.isNotValidAtThisTime)
			flags |= Perspectives.overrideService.ERROR_TIME;

		Perspectives.overrideService.rememberValidityOverride(
			uri.asciiHost, uri.port, cert, flags, isTemp);

		setTimeout(function (){ browser.loadURIWithFlags(uri.spec, flags);}, 25);
		return true;
	},


	// Updates the status of the current page 
	updateStatus: function(win, is_forced){

		if(Perspectives.strbundle == null) 
			Perspectives.strbundle = document.getElementById("notary_strings");

		Pers_debug.d_print("main", "Update Status\n");
		
		var error_text = Perspectives.detectInvalidURI(win); 
		if(error_text) { 	
			Pers_statusbar.setStatus(null, Pers_statusbar.STATE_NEUT, "Waiting on URL data from Firefox (" + error_text + ")");
			return; 
		} 
		var ti = Perspectives.getCurrentTabInfo(win);
		if(ti.uri.scheme != "https"){
			var text = Perspectives.strbundle.
				getFormattedString("nonHTTPSError", [ ti.uri.host, ti.uri.scheme ]);
			Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NEUT, text); 
			ti.reason_str = text;
			return;
		} 
		
		Pers_debug.d_print("main", "Update Status: " + ti.uri.spec + "\n");
		
		ti.cert       = Perspectives.getCertificate(ti.browser);
		if(!ti.cert){
			var text = Perspectives.strbundle.
				getFormattedString("noCertError", [ ti.uri.host ])
			Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NEUT, text); 
			ti.reason_str = text;
			return;
		}
  
		var md5        = ti.cert.md5Fingerprint.toLowerCase();
		ti.state      = ti.browser.securityUI.state;

		ti.is_override_cert = Perspectives.overrideService.isCertUsedForOverrides(ti.cert, true, true);
		Pers_debug.d_print("main", 
			"is_override_cert = " + ti.is_override_cert + "\n"); 
		var check_good = Perspectives.root_prefs.
			getBoolPref("perspectives.check_good_certificates"); 

		
		// see if the browser has this cert installed prior to this browser session
		// seems like we can't tell the difference between an exception added by the user 
		// manually and one we installed permanently during a previous browser run.  
		ti.already_trusted = !(ti.state & Perspectives.state.STATE_IS_INSECURE) && !(ti.is_override_cert); 
		
		if(Perspectives.is_whitelisted_by_user(ti.uri.host)) {
			if(! (ti.already_trusted || ti.is_override_cert)) { 		
				var isTemp = !Perspectives.root_prefs.getBoolPref("perspectives.exceptions.permanent");
				setTimeout(function() {  
					if(Perspectives.do_override(ti.browser, ti.cert, isTemp)) { 
						Perspectives.setFaviconText("Certificate trusted based on Perspectives whitelist"); 
						Pers_notify.do_notify(ti, Pers_notify.TYPE_WHITELIST);
					}
				}, 1000); 
			} 
			var text = "You have configured Perspectives to whitelist connections to '" + 
									ti.uri.host  + "'";
			Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_SEC, text); 
			ti.reason_str = text;
			return; 
		} else { 

			// Note: we no longer do a DNS look-up to to see if a DNS name maps 
			// to an RFC 1918 address, as this 'leaked' DNS info for users running
			// anonymizers like Tor.  It was always just an insecure guess anyway.  
			var unreachable = Perspectives.is_nonrouted_ip(ti.uri.host); 
			if(unreachable) { 
				var text = Perspectives.strbundle.
					getFormattedString("rfc1918Error", [ ti.uri.host ])
				Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NEUT, text); 
				ti.reason_str = text;
				return;
			}
		}   

		if(!check_good && ti.already_trusted && !is_forced) {
			var text = Perspectives.strbundle.
				getString("noProbeRequestedError"); 
			Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NEUT, text); 
			ti.reason_str = text;
			return;
		} 

		// clear cache if it is stale 
		var unix_time = Pers_util.get_unix_time();
		var max_cache_age_sec = Perspectives.root_prefs.getIntPref("perspectives.max_cache_age_sec");  
		if(ti.query_results && ti.query_results.created < (unix_time - max_cache_age_sec)) {
			Pers_debug.d_print("main", "Cached query results are stale.  Re-evaluate security."); 
			delete ti.query_results; 
		}  
		if(ti.query_results && ti.query_results.md5 != md5) { 
			Pers_debug.d_print("main", "Current and cached key disagree.  Re-evaluate security."); 
			delete ti.query_results; 
		}   
		
		if(ti.query_results) { 
			Perspectives.process_notary_results(ti);
		} else {  
			Pers_debug.d_print("main", ti.uri.host + " needs a request\n"); 
			var needs_perm = Perspectives.root_prefs
					.getBoolPref("perspectives.require_user_permission"); 
			if(needs_perm && !ti.has_user_permission) {
				Pers_debug.d_print("main", "needs user permission\n");  
				Pers_notify.do_notify(ti, Pers_notify.TYPE_NEEDS_PERMISSION);
				var text = Perspectives.strbundle.getString("needsPermission"); 
				Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NEUT, text); 
				ti.reason_str = text;
				return; 
			} 
   

			// make sure we're using the most recent notary list
			Perspectives.all_notaries = this.getNotaryList(); 
			if(Perspectives.all_notaries.length == 0) { 
				Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NEUT, "List of notary servers is empty."); 
				return; 
			} 
 
			Pers_debug.d_print("main", "Contacting notaries\n"); 
			// this call is asynchronous.  after hearing from the 
			// notaries, the logic picks up again with the function 
			// 'process_notary_results()' below
			this.queryNotaries(ti);
		}
	},

	process_notary_results: function(ti) {  
		try {
			if(!ti.already_trusted && !ti.query_results.identityText &&
				Perspectives.getFaviconText().indexOf("Perspectives") < 0){
				ti.query_results.identityText = 
					Perspectives.setFaviconText(Perspectives.getFaviconText() +
					"\n\n" + "Perspectives has validated this site");
			}
			var required_duration   = 
				Perspectives.root_prefs.
					getIntPref("perspectives.required_duration");

			var strong_trust = ti.query_results.cur_consistent && 
						(ti.query_results.duration >= required_duration); 
			var pref_https_weak = Perspectives.root_prefs.
					getBoolPref("perspectives.trust_https_with_weak_consistency");
			var weak_trust = ti.query_results.inconsistent_results && ti.query_results.weakly_seen; 
	
			if(strong_trust) {
				// FIXME: need to clear any contrary banners
				var mixed_security =  ti.state & Perspectives.state.STATE_IS_BROKEN; 
				if(!ti.is_override_cert && (ti.state & Perspectives.state.STATE_IS_INSECURE)){
					ti.exceptions_enabled = Perspectives.root_prefs.
						getBoolPref("perspectives.exceptions.enabled")
					if(ti.exceptions_enabled) { 
						ti.override_used = true; 
						var isTemp = !Perspectives.root_prefs.
							getBoolPref("perspectives.exceptions.permanent");
						Perspectives.do_override(ti.browser, ti.cert, isTemp);
						ti.query_results.identityText = Perspectives.strbundle.
							getString("exceptionAdded");  
						// don't give drop-down if user gave explicit
						// permission to query notaries
						if(ti.firstLook && !ti.has_user_permission){
							Pers_notify.do_notify(ti, Pers_notify.TYPE_OVERRIDE);
						}
					}
				}

				// Check if this site includes insecure embedded content.  If so, do not 
				// show a green check mark, as we don't want people to incorrectly assume 
				// that we imply that the site is secure.  Note: we still will query the 
				// notary and will override an error page.  This is inline with the fact 
				// that Firefox still shows an HTTPS page with insecure content, it
				// just does not show positive security indicators.  
				if(mixed_security) { 
					// FIXME: need to clear any contrary banners
					Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NEUT, 
					"HTTPS Certificate is trusted, but site contains insecure embedded content. ");
					// this will flicker, as we can't rely on just doing it on 'firstLook'
					// due to Firefox oddness
					if(ti.override_used) { 	
						Pers_notify.do_notify(ti, Pers_notify.TYPE_OVERRIDE_MIXED);
					}
				}  else { 

					ti.query_results.tooltip = Perspectives.strbundle.
						getFormattedString("verifiedMessage", 
						[ ti.query_results.duration, required_duration]);
					Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_SEC, 
						ti.query_results.tooltip);
				}
			} else if(ti.already_trusted && weak_trust && pref_https_weak) { 
				// FIXME: need to clear any contrary banners
				if(ti.state & Perspectives.state.STATE_IS_BROKEN) { 
					Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NEUT, 
					"HTTPS Certificate is weakly trusted, but site contains insecure embedded content. ");
				}  else { 
					Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_SEC, 
					"This site uses multiple certificates, including the certificate received and trusted by your browser.");

				} 
			} else if (ti.query_results.summary.indexOf("ssl key") == -1) { 
				// FIXME: need to clear any contrary banners
				ti.query_results.tooltip = 
					Perspectives.strbundle.getString("noRepliesWarning");
				Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NSEC, 
					ti.query_results.tooltip);
				if(!ti.already_trusted) { 
					Pers_notify.do_notify(ti, Pers_notify.TYPE_NO_REPLIES);
				} 
			} else if(ti.query_results.inconsistent_results && !ti.query_results.weakly_seen) { 
				// FIXME: need to clear any contrary banners
				ti.query_results.tooltip = "This site regularly uses multiples certificates, and most Notaries have not recently seen the certificate received by the browser";
				Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NSEC, 
					ti.query_results.tooltip);
			} else if(ti.query_results.inconsistent_results) { 
				// FIXME: need to clear any contrary banners
				ti.query_results.tooltip = "Perspectives is unable to validate this site, because the site regularly uses multiples certificates"; 
				Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NSEC, 
					ti.query_results.tooltip);
			} else if(!ti.query_results.cur_consistent){
				// FIXME: need to clear any contrary banners
				ti.query_results.tooltip = 
					Perspectives.strbundle.getString("inconsistentWarning");
				Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NSEC, 
					ti.query_results.tooltip);
				// we may reconsider this in the future, but currently we don't do a 
				// drop-down if things aren't consistent but the browser already trusts the cert. 
				if(!ti.already_trusted && ti.firstLook){
					Pers_notify.do_notify(ti, Pers_notify.TYPE_FAILED);
				}
			} else if(ti.query_results.duration < required_duration){
				// FIXME: need to clear any contrary banners
				ti.query_results.tooltip = Perspectives.strbundle.
					getFormattedString("thresholdWarning", 
					[ ti.query_results.duration, required_duration]);
				Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_NSEC, 
					ti.query_results.tooltip);
				if(!ti.already_trusted && ti.firstLook){
					Pers_notify.do_notify(ti, Pers_notify.TYPE_FAILED);
				}
			} else { 
				// FIXME: need to clear any contrary banners
				ti.query_results.tooltip = "An unknown Error occurred processing Notary results";
				Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_ERROR, 
					ti.query_results.tooltip);
			} 
		

			if(ti.query_results.identityText){
				Perspectives.setFaviconText(ti.query_results.identityText);
			}

 
		} catch (err) {
			alert("process_notary_results error: " + err);
		}
	},

	is_whitelisted_by_user : function(host) {
		try { 
			/* be cautious in case we got a bad user edit to the whitelist */  
			var whitelist = Perspectives.root_prefs.
				    getCharPref("perspectives.whitelist").split(",");
			for(var entry in whitelist) {
				var e = whitelist[entry]; 
				if(e.length == 0) { 
					continue; 
				} 
				var r = RegExp(e);
				if (host.match(r)) {
					return true; 
				} 
			} 
		} catch(e) { /* ignore */ } 
		return false; 
	},

	 

	// See Documentation for nsIWebProgressListener at: 
	// https://developer.mozilla.org/en/nsIWebProgressListener

	// The current approach is to clear the previous status
	// icon during onLocationChange.  For each call to 
	// onSecurityChange, we call updateStatus. 
	// Then, when onStateChange is called with STATE_STOP
	// we call updateStatus one last time just for good 
	// measure, as this should be the last thing that happens. 
	//
	// NOTE: this code needs some TLC

	//note can use request to suspend the loading
	notaryListener : { 

   		// Note: We intentially do NOT call updateStatus from here, as this
   		// was causing a bug that caused us to get the previous website's cert
   		// instead of the correct cert.  
   		onLocationChange: function(aWebProgress, aRequest, aURI) {
      			try{
        			Pers_debug.d_print("main", "Location change " + aURI.spec + "\n");
        			Pers_statusbar.setStatus(aURI, Pers_statusbar.STATE_QUERY, 
							"Contacting notaries about '" + aURI.host + "'");
      			} catch(err){
        			Pers_debug.d_print("error", "Perspectives had an internal exception: " + err);
        			Pers_statusbar.setStatus(aURI, Pers_statusbar.STATE_ERROR, 
					"Perspectives: an internal error occurred: " + err);
      			}

   		},

   		// we only call updateStatus on STATE_STOP, as a catch all in case
   		// onSecurityChange was never called. 
   		onStateChange: function(aWebProgress, aRequest, aFlag, aStatus) {
     			
			if(aFlag & Components.interfaces.nsIWebProgressListener.STATE_STOP){
       			  try {
     				var uri = window.gBrowser.currentURI;
     				Pers_debug.d_print("main", "State change " + uri.spec + "\n");
         			Perspectives.updateStatus(window,false);
       			  } catch (err) {
         			Pers_debug.d_print("Perspectives had an internal exception: " + err);
         			Pers_statusbar.setStatus(Pers_statusbar.STATE_ERROR, 
					"Perspectives: an internal error occurred: " + err);
       			  }
     			}
  		},

  		// this is the main function we key off of.  It seems to work well, even though
  		// the docs do not explicitly say when it will be called. 
  		onSecurityChange:    function() {
       			var uri = null;
       			try{
         			uri = window.gBrowser.currentURI;
         			Pers_debug.d_print("main", "Security change " + uri.spec + "\n");
         			Perspectives.updateStatus(window,false);
       			} catch(err){
         			Pers_debug.d_print("error", "Perspectives had an internal exception: " + err);
         			if(uri) {
          				Pers_statusbar.setStatus(uri, Pers_statusbar.STATE_ERROR, 
						"Perspectives: an internal error occurred: " + err);
         			}
       			}
 
  		},

		onStatusChange:      function() { },
		onProgressChange:    function() { },
		onLinkIconAvailable: function() { }
	},



	requeryAllTabs: function(b){
		/*
		alert("requeryAllTabs is disabled"); 
		var num = b.browsers.length;
		for (var i = 0; i < num; i++) {
			var browser = b.getBrowserAtIndex(i);
			Perspectives.updateStatus(window,false);
		}
		*/ 
	},

	initNotaries: function(){
		try {
			Pers_debug.d_print("main", "\nPerspectives Initialization\n");

			var auto_update = this.root_prefs.getBoolPref("perspectives.enable_default_list_auto_update");
			if(auto_update) { 
				Pers_util.update_default_notary_list_from_web(this.root_prefs);
			} else {  
				Pers_util.update_default_notary_list_from_file(this.root_prefs); 
			} 
        		Pers_debug.d_print("main", Perspectives.notaries); 	
			Pers_statusbar.setStatus(null, Pers_statusbar.STATE_NEUT, "");
			getBrowser().addProgressListener(Perspectives.notaryListener, 
			Components.interfaces.nsIWebProgress.NOTIFY_STATE_DOCUMENT);
			setTimeout(function (){ Perspectives.requeryAllTabs(gBrowser); }, 4000);
			Pers_debug.d_print("main", "Perspectives Finished Initialization\n\n");
		} catch(e) { 
			alert("Error in initNotaries: " + e); 
		} 
	},

	detectInvalidURI : function(win) { 
		if(!win.gBrowser){
			Pers_debug.d_print("error","No Browser!!\n");
			return "No browser object found for this window";
		}
		
		var uri = win.gBrowser.currentURI; 
		if(!uri) { 
			return Perspectives.strbundle.getString("noDataError"); 
		}
		
		// sometimes things blow up because accessing uri.host throws an exception
		try { 
			var ignore = uri.host;
			if(!uri.host) throw "";  
		} catch(e) {
			return "URL is not a valid remote server"; 
		}
		return null; 
	}, 

	getCurrentTabInfo : function(win) { 
		var uri = win.gBrowser.currentURI; 
		var port = (uri.port == -1) ? 443 : uri.port;  
		var service_id = uri.host + ":" + port + ",2"; 

		var ti = Perspectives.tab_info_cache[service_id]; 
		if(!ti) {
			ti = {};
			// defaults 
			ti.firstLook = true; 
			ti.override_used = false;
			ti.has_user_permission = false; 
			ti.last_banner_type = null; 
			Perspectives.tab_info_cache[service_id] = ti; 
		}
		ti.uri = uri;
		ti.host = uri.host; 
		ti.service_id = service_id; 
		ti.browser = win.gBrowser; 
		ti.reason_str = "";
		return ti; 
	},  

	forceStatusUpdate : function(win) {
		var error_text = Perspectives.detectInvalidURI(win);  
		if(error_text) { 
			alert("Perspectives: Invalid URI (" + error_text + ")"); 
			return; 
		} 
		var ti = Perspectives.getCurrentTabInfo(win);
		if(ti) { 		
			Pers_debug.d_print("main", "Forced request, clearing cache for '" + ti.uri.host + "'"); 
			delete ti.query_results; 
			ti.has_user_permission = true; // forcing a check is implicit permission  
			Pers_statusbar.setStatus(ti.uri, Pers_statusbar.STATE_QUERY, "Contacting notaries about '" + ti.uri.host + "'");
			Perspectives.updateStatus(win, true); 
		} else { 
			Pers_debug.d_print("main", "Requested force check with valid URI, but no tab_info is found"); 
		} 
	}, 

	prompt_update: function() {
		var ask_update = Perspectives.root_prefs.
                getBoolPref("perspectives.prompt_update_all_https_setting");
		if (ask_update == true) {
			var check_good = Perspectives.root_prefs.
					getBoolPref("perspectives.check_good_certificates");
			if (!check_good) {
				var prompts = Cc["@mozilla.org/embedcomp/prompt-service;1"]
						.getService(Components.interfaces.nsIPromptService);
				var check = {value:false};
				var buttons = 
						prompts.BUTTON_POS_0 * prompts.BUTTON_TITLE_IS_STRING
						+ prompts.BUTTON_POS_1 * prompts.BUTTON_TITLE_IS_STRING;

				var answer = prompts.confirmEx(null, "Perspectives update", 
					"Thank you for using Perspectives. The default settings " +
					"have been updated to query the notary server for all " + 
					"HTTPS sites. Do you want to update this setting to use " +
					"the default or keep your current settings?", buttons, 
					"Update Settings", "Keep current settings", "", null, 
					check);
				if (answer == 0) {
					Perspectives.root_prefs.
						setBoolPref("perspectives.check_good_certificates", 
									true); 
				}
			}
			Perspectives.root_prefs.
					setBoolPref("perspectives.prompt_update_all_https_setting",
								false);
		}
	}
			
}

