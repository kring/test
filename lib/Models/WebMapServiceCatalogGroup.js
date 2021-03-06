'use strict';

/*global require*/
var URI = require('URIjs');

var clone = require('terriajs-cesium/Source/Core/clone');
var combine = require('terriajs-cesium/Source/Core/combine');
var defaultValue = require('terriajs-cesium/Source/Core/defaultValue');
var defined = require('terriajs-cesium/Source/Core/defined');
var defineProperties = require('terriajs-cesium/Source/Core/defineProperties');
var freezeObject = require('terriajs-cesium/Source/Core/freezeObject');
var knockout = require('terriajs-cesium/Source/ThirdParty/knockout');
var loadXML = require('terriajs-cesium/Source/Core/loadXML');
var GeographicTilingScheme = require('terriajs-cesium/Source/Core/GeographicTilingScheme');

var ModelError = require('./ModelError');
var CatalogGroup = require('./CatalogGroup');
var inherit = require('../Core/inherit');
var WebMapServiceCatalogItem = require('./WebMapServiceCatalogItem');
var xml2json = require('../ThirdParty/xml2json');

/**
 * A {@link CatalogGroup} representing a collection of layers from a Web Map Service (WMS) server.
 *
 * @alias WebMapServiceCatalogGroup
 * @constructor
 * @extends CatalogGroup
 *
 * @param {Terria} terria The Terria instance.
 */
var WebMapServiceCatalogGroup = function(terria) {
     CatalogGroup.call(this, terria, 'wms-getCapabilities');

    /**
     * Gets or sets the URL of the WMS server.  This property is observable.
     * @type {String}
     */
    this.url = '';

    /**
     * Gets or sets a description of the custodian of the data sources in this group.
     * This property is an HTML string that must be sanitized before display to the user.
     * This property is observable.
     * @type {String}
     */
    this.dataCustodian = undefined;

    /**
     * Gets or sets the additional parameters to pass to the WMS server when requesting images.
     * If this property is undefiend, {@link WebMapServiceCatalogItem.defaultParameters} is used.
     * @type {Object}
     */
    this.parameters = undefined;

    /**
     * Gets or sets a hash of names of blacklisted data layers.  A layer that appears in this hash
     * will not be shown to the user.  In this hash, the keys should be the Title of the layers to blacklist,
     * and the values should be "true".  This property is observable.
     * @type {Object}
     */
    this.blacklist = undefined;

    /**
     * Gets or sets the field name to use as the primary title in the catalog view: each WMS layer's
     * "title" (default), "name", or "abstract".
     * @type {String}
     */
    this.titleField = 'title';

    /**
     * Gets or sets a hash of properties that will be set on each child item.
     * For example, { 'treat404AsError': false }
     */
    this.itemProperties = undefined;

    knockout.track(this, ['url', 'dataCustodian', 'parameters', 'blacklist', 'titleField', 'itemProperties']);
};

inherit(CatalogGroup, WebMapServiceCatalogGroup);

defineProperties(WebMapServiceCatalogGroup.prototype, {
    /**
     * Gets the type of data member represented by this instance.
     * @memberOf WebMapServiceCatalogGroup.prototype
     * @type {String}
     */
    type : {
        get : function() {
            return 'wms-getCapabilities';
        }
    },

    /**
     * Gets a human-readable name for this type of data source, such as 'Web Map Service (WMS)'.
     * @memberOf WebMapServiceCatalogGroup.prototype
     * @type {String}
     */
    typeName : {
        get : function() {
            return 'Web Map Service (WMS) Server';
        }
    },

    /**
     * Gets the set of functions used to serialize individual properties in {@link CatalogMember#serializeToJson}.
     * When a property name on the model matches the name of a property in the serializers object lieral,
     * the value will be called as a function and passed a reference to the model, a reference to the destination
     * JSON object literal, and the name of the property.
     * @memberOf WebMapServiceCatalogGroup.prototype
     * @type {Object}
     */
    serializers : {
        get : function() {
            return WebMapServiceCatalogGroup.defaultSerializers;
        }
    }
});

/**
 * Gets or sets the set of default serializer functions to use in {@link CatalogMember#serializeToJson}.  Types derived from this type
 * should expose this instance - cloned and modified if necesary - through their {@link CatalogMember#serializers} property.
 * @type {Object}
 */
WebMapServiceCatalogGroup.defaultSerializers = clone(CatalogGroup.defaultSerializers);

WebMapServiceCatalogGroup.defaultSerializers.items = function(wmsGroup, json, propertyName, options) {
    // Only serialize minimal properties in contained items, because other properties are loaded from GetCapabilities.
    var previousSerializeForSharing = options.serializeForSharing;
    options.serializeForSharing = true;

    // Only serlize enabled items as well.  This isn't quite right - ideally we'd serialize any
    // property of any item if the property's value is changed from what was loaded from GetCapabilities -
    // but this gives us reasonable results for sharing and is a lot less work than the ideal
    // solution.
    var previousEnabledItemsOnly = options.enabledItemsOnly;
    options.enabledItemsOnly = true;

    var result = CatalogGroup.defaultSerializers.items(wmsGroup, json, propertyName, options);

    options.enabledItemsOnly = previousEnabledItemsOnly;
    options.serializeForSharing = previousSerializeForSharing;

    return result;
};

WebMapServiceCatalogGroup.defaultSerializers.isLoading = function(wmsGroup, json, propertyName, options) {};

freezeObject(WebMapServiceCatalogGroup.defaultSerializers);

WebMapServiceCatalogGroup.prototype._getValuesThatInfluenceLoad = function() {
    return [this.url, this.blacklist, this.titleField];
};

WebMapServiceCatalogGroup.prototype._load = function() {
    var url = cleanAndProxyUrl( this.terria, this.url) + '?service=WMS&request=GetCapabilities&version=1.3.0&tiled=true';

    var that = this;
    return loadXML(url).then(function(xml) {
        // Is this really a GetCapabilities response?
        if (!xml || !xml.documentElement || (xml.documentElement.localName !== 'WMS_Capabilities' && xml.documentElement.localName !== 'WMT_MS_Capabilities')) {
            throw new ModelError({
                title: 'Invalid WMS server',
                message: '\
An error occurred while invoking GetCapabilities on the WMS server.  The server\'s response does not appear to be a valid GetCapabilities document.  \
<p>If you entered the link manually, please verify that the link is correct.</p>\
<p>If you did not enter this link manually, this error may indicate that the group you opened is temporarily unavailable or there is a \
problem with your internet connection.  Try opening the group again, and if the problem persists, please report it by \
sending an email to <a href="mailto:nationalmap@lists.nicta.com.au">nationalmap@lists.nicta.com.au</a>.</p>'
            });
        }

        var json = xml2json(xml);

        var supportsJsonGetFeatureInfo = false;
        var supportsXmlGetFeatureInfo = false;
        var xmlContentType = 'text/xml';

        if (defined(json.Capability.Request) &&
            defined(json.Capability.Request.GetFeatureInfo) &&
            defined(json.Capability.Request.GetFeatureInfo.Format)) {

            var format = json.Capability.Request.GetFeatureInfo.Format;
            if (format === 'application/json') {
                supportsJsonGetFeatureInfo = true;
            } else if (defined(format.indexOf) && format.indexOf('application/json') >= 0) {
                supportsJsonGetFeatureInfo = true;
            }

            if (format === 'text/xml' || format === 'application/vnd.ogc.gml') {
                supportsXmlGetFeatureInfo = true;
                xmlContentType = format;
            } else if (defined(format.indexOf) && format.indexOf('text/xml') >= 0) {
                supportsXmlGetFeatureInfo = true;
                xmlContentType = 'text/xml';
            } else if (defined(format.indexOf) && format.indexOf('application/vnd.ogc.gml') >= 0) {
                supportsXmlGetFeatureInfo = true;
                xmlContentType = 'application/vnd.ogc.gml';
            }
        }

        var dataCustodian = that.dataCustodian;
        if (!defined(dataCustodian) && defined(json.Service.ContactInformation)) {
            var contactInfo = json.Service.ContactInformation;

            var text = '';

            var primary = contactInfo.ContactPersonPrimary;
            if (defined(primary)) {
                if (defined(primary.ContactOrganization) && primary.ContactOrganization.length > 0) {
                    text += primary.ContactOrganization + '<br/>';
                }
            }

            if (defined(contactInfo.ContactElectronicMailAddress) && contactInfo.ContactElectronicMailAddress.length > 0) {
                text += '[' + contactInfo.ContactElectronicMailAddress + '](mailto:' + contactInfo.ContactElectronicMailAddress + ')<br/>';
            }

            dataCustodian = text;
        }

        addLayersRecursively(that, json.Capability.Layer, that.items, undefined, supportsJsonGetFeatureInfo, supportsXmlGetFeatureInfo, xmlContentType, dataCustodian);
    }).otherwise(function(e) {
        throw new ModelError({
            sender: that,
            title: 'Group is not available',
            message: '\
An error occurred while invoking GetCapabilities on the WMS server.  \
<p>If you entered the link manually, please verify that the link is correct.</p>\
<p>This error may also indicate that the server does not support <a href="http://enable-cors.org/" target="_blank">CORS</a>.  If this is your \
server, verify that CORS is enabled and enable it if it is not.  If you do not control the server, \
please contact the administrator of the server and ask them to enable CORS.  Or, contact the National \
Map team by emailing <a href="mailto:nationalmap@lists.nicta.com.au">nationalmap@lists.nicta.com.au</a> \
and ask us to add this server to the list of non-CORS-supporting servers that may be proxied by \
National Map itself.</p>\
<p>If you did not enter this link manually, this error may indicate that the group you opened is temporarily unavailable or there is a \
problem with your internet connection.  Try opening the group again, and if the problem persists, please report it by \
sending an email to <a href="mailto:nationalmap@lists.nicta.com.au">nationalmap@lists.nicta.com.au</a>.</p>'
        });
    });
};

function cleanAndProxyUrl(terria, url) {
    // Strip off the search portion of the URL
    var uri = new URI(url);
    uri.search('');

    var cleanedUrl = uri.toString();
    if (defined(terria.corsProxy) && terria.corsProxy.shouldUseProxy(cleanedUrl)) {
        cleanedUrl = terria.corsProxy.getURL(cleanedUrl, '1d');
    }

    return cleanedUrl;
}

function addLayersRecursively(wmsGroup, layers, items, parent, supportsJsonGetFeatureInfo, supportsXmlGetFeatureInfo, xmlContentType, dataCustodian) {
    if (!(layers instanceof Array)) {
        layers = [layers];
    }

    for (var i = 0; i < layers.length; ++i) {
        var layer = layers[i];

        // Record this layer's parent, so we can walk up the layer hierarchy looking for inherited properties.
        layer.parent = parent;

        if (wmsGroup.blacklist && wmsGroup.blacklist[layer.Title]) {
            console.log('Provider Feedback: Filtering out ' + layer.Title + ' (' + layer.Name + ') because it is blacklisted.');
            continue;
        }

        if (defined(layer.Layer)) {
            // WMS 1.1.1 spec section 7.1.4.5.2 says any layer with a Name property can be used
            // in the 'layers' parameter of a GetMap request.  This is true in 1.0.0 and 1.3.0 as well.
            if (defined(layer.Name) && layer.Name.length > 0) {
                items.push(createWmsDataSource(wmsGroup, layer, supportsJsonGetFeatureInfo, supportsXmlGetFeatureInfo, xmlContentType, dataCustodian));
            }
            addLayersRecursively(wmsGroup, layer.Layer, items, layer, supportsJsonGetFeatureInfo, supportsXmlGetFeatureInfo, xmlContentType, dataCustodian);
        }
        else {
            items.push(createWmsDataSource(wmsGroup, layer, supportsJsonGetFeatureInfo, supportsXmlGetFeatureInfo, xmlContentType, dataCustodian));
        }
    }
}

function createWmsDataSource(wmsGroup, layer, supportsJsonGetFeatureInfo, supportsXmlGetFeatureInfo, xmlContentType, dataCustodian) {
    var result = new WebMapServiceCatalogItem(wmsGroup.terria);

    if (wmsGroup.titleField === 'name') {
        result.name = layer.Name;
    } else if (wmsGroup.titleField === 'abstract') {
        result.name = layer.Abstract;
    } else {
        result.name = layer.Title;
    }
    result.description = defined(layer.Abstract) && layer.Abstract.length > 0 ? layer.Abstract : wmsGroup.description;
    result.dataCustodian = dataCustodian;
    result.url = wmsGroup.url;
    result.layers = layer.Name;
    result.parameters = wmsGroup.parameters;
    result.minScaleDenominator = layer.MinScaleDenominator;

    result.description = '';

    var wmsGroupHasDescription = defined(wmsGroup.description) && wmsGroup.description.length > 0;
    var layerHasAbstract = defined(layer.Abstract) && layer.Abstract.length > 0;

    if (wmsGroupHasDescription) {
        result.description += wmsGroup.description;
    }

    if (wmsGroupHasDescription && layerHasAbstract) {
        result.description += '<br/>';
    }

    if (layerHasAbstract) {
        result.description += layer.Abstract;
    }

    if (typeof(wmsGroup.itemProperties) === 'object') {
        Object.keys(wmsGroup.itemProperties).forEach(function(k) {
            result[k] = wmsGroup.itemProperties[k];
        });
    }


    var queryable = defaultValue(getInheritableProperty(layer, 'queryable'), false);

    result.getFeatureInfoAsGeoJson = queryable && supportsJsonGetFeatureInfo;
    result.getFeatureInfoAsXml = queryable && supportsXmlGetFeatureInfo;
    result.getFeatureInfoXmlContentType = xmlContentType;

    result.rectangle = WebMapServiceCatalogItem.getRectangleFromLayer(layer);
    result.intervals = WebMapServiceCatalogItem.getIntervalsFromLayer(layer);

    var crs;
    if (defined(layer.CRS)) {
        crs = getInheritableProperty(layer, 'CRS', true);
    } else {
        crs = getInheritableProperty(layer, 'SRS', true);
    }

    if (defined(crs)) {
        if (crsIsMatch(crs, 'EPSG:3857')) {
            // Standard Web Mercator
        } else if (crsIsMatch(crs, 'EPSG:900913')) {
            // Older code for Web Mercator
            result.parameters = combine(result.parameters, {srs: 'EPSG:900913'});
        } else if (crsIsMatch(crs, 'EPSG:4326')) {
            // Standard Geographic
            result.tilingScheme = new GeographicTilingScheme();
        } else if (crsIsMatch(crs, 'CRS:84')) {
            // Another name for EPSG:4326
            result.tilingScheme = new GeographicTilingScheme();
            result.parameters = combine(result.parameters, {srs: 'CRS:84'});
        } else if (crsIsMatch(crs, 'EPSG:4283')) {
            // Australian system that is equivalent to EPSG:4326.
            result.tilingScheme = new GeographicTilingScheme();
            result.parameters = combine(result.parameters, {srs: 'EPSG:4283'});
        } else {
            // No known supported CRS listed.  Try the default, EPSG:3857, and hope for the best.
        }
    }


    return result;
}

function crsIsMatch(crs, matchValue) {
    if (crs === matchValue) {
        return true;
    }

    if (crs instanceof Array && crs.indexOf(matchValue) >= 0) {
        return true;
    }

     return false;
}

function getInheritableProperty(layer, name, appendValues) {
    var value = [];
    while (defined(layer)) {
        if (defined(layer[name])) {
            if (appendValues) {
                value = value.concat((layer[name] instanceof Array) ? layer[name] : [layer[name]]);
            } else {
                return layer[name];
            }
        }
        layer = layer.parent;
    }

    return value.length > 0 ? value : undefined;
}

module.exports = WebMapServiceCatalogGroup;
